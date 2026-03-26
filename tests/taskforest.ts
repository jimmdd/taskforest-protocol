import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Taskforest } from "../target/types/taskforest";
import { expect } from "chai";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";

describe("taskforest core", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Taskforest as Program<Taskforest>;
  const poster = provider.wallet;

  const seed = {
    job: Buffer.from("job"),
    dispute: Buffer.from("dispute"),
  };

  function pdaJob(posterKey: PublicKey, jobId: BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [seed.job, posterKey.toBuffer(), jobId.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
  }

  function pdaDispute(job: PublicKey, disputedThread: number): PublicKey {
    const thread = Buffer.alloc(4);
    thread.writeUInt32LE(disputedThread, 0);
    return PublicKey.findProgramAddressSync(
      [seed.dispute, job.toBuffer(), thread],
      program.programId
    )[0];
  }

  function nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  function hash32(fill: number): number[] {
    return Array.from({ length: 32 }, () => fill);
  }

  function errToString(err: unknown): string {
    if (err instanceof Error) {
      return err.toString();
    }
    return String(err);
  }

  async function airdrop(kp: Keypair, sol = 3): Promise<void> {
    const sig = await provider.connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
    const latest = await provider.connection.getLatestBlockhash("confirmed");
    await provider.connection.confirmTransaction(
      {
        signature: sig,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      "confirmed"
    );
  }

  async function initJob(jobId: BN, deadline: BN, verificationLevel = 0): Promise<PublicKey> {
    const job = pdaJob(poster.publicKey, jobId);
    await program.methods
      .initializeJob(
        jobId,
        new BN(2_000_000),
        deadline,
        hash32(1),
        hash32(2),
        0,
        hash32(0),
        0,
        verificationLevel,
        0
      )
      .accountsPartial({
        job,
        poster: poster.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return job;
  }

  it("initialize_job creates state with valid params", async () => {
    const jobId = new BN(1001);
    const deadline = new BN(nowSec() + 600);
    const job = await initJob(jobId, deadline, 0);
    const fetched = await program.account.job.fetch(job);
    expect(fetched.poster.toBase58()).to.eq(poster.publicKey.toBase58());
    expect(fetched.jobId.toString()).to.eq(jobId.toString());
    expect(fetched.rewardLamports.toString()).to.eq("2000000");
    expect(fetched.deadline.toString()).to.eq(deadline.toString());
    expect(fetched.specHash).to.deep.eq(hash32(1));
    expect(fetched.status).to.eq(0);
  });

  it("initialize_job fails with zero reward", async () => {
    const jobId = new BN(1002);
    const job = pdaJob(poster.publicKey, jobId);
    try {
      await program.methods
        .initializeJob(
          jobId,
          new BN(0),
          new BN(nowSec() + 600),
          hash32(1),
          hash32(2),
          0,
          hash32(0),
          0,
          0,
          0
        )
        .accountsPartial({
          job,
          poster: poster.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("expected InvalidReward");
    } catch (err: unknown) {
      expect(errToString(err)).to.include("InvalidReward");
    }
  });

  it("initialize_job fails with past deadline", async () => {
    const jobId = new BN(1003);
    const job = pdaJob(poster.publicKey, jobId);
    try {
      await program.methods
        .initializeJob(
          jobId,
          new BN(1_000_000),
          new BN(nowSec() - 60),
          hash32(1),
          hash32(2),
          0,
          hash32(0),
          0,
          0,
          0
        )
        .accountsPartial({
          job,
          poster: poster.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("expected InvalidDeadline");
    } catch (err: unknown) {
      expect(errToString(err)).to.include("InvalidDeadline");
    }
  });

  it("place_bid on an open job", async () => {
    const bidder = Keypair.generate();
    await airdrop(bidder);
    const job = await initJob(new BN(1004), new BN(nowSec() + 600), 0);

    await program.methods
      .placeBid(new BN(300_000))
      .accountsPartial({
        job,
        bidder: bidder.publicKey,
      })
      .signers([bidder])
      .rpc();

    const fetched = await program.account.job.fetch(job);
    expect(fetched.status).to.eq(1);
    expect(fetched.bidCount).to.eq(1);
    expect(fetched.bestBidStake.toString()).to.eq("300000");
    expect(fetched.bestBidder.toBase58()).to.eq(bidder.publicKey.toBase58());
  });

  it("close_bidding closes and selects winner", async () => {
    const bidder = Keypair.generate();
    await airdrop(bidder);
    const job = await initJob(new BN(1005), new BN(nowSec() + 600), 0);

    await program.methods
      .placeBid(new BN(400_000))
      .accountsPartial({ job, bidder: bidder.publicKey })
      .signers([bidder])
      .rpc();

    await program.methods
      .closeBidding()
      .accountsPartial({
        payer: poster.publicKey,
        job,
      })
      .rpc();

    const fetched = await program.account.job.fetch(job);
    expect(fetched.status).to.eq(2);
    expect(fetched.claimer.toBase58()).to.eq(bidder.publicKey.toBase58());
    expect(fetched.claimerStake.toString()).to.eq("400000");
  });

  it("submit_proof stores proof hash", async () => {
    const claimer = Keypair.generate();
    const job = await initJob(new BN(1006), new BN(nowSec() + 600), 0);

    await program.methods
      .autoAssignJob(claimer.publicKey)
      .accountsPartial({ job, poster: poster.publicKey })
      .rpc();

    await program.methods
      .submitProof(hash32(9))
      .accountsPartial({
        job,
        submitter: claimer.publicKey,
      })
      .signers([claimer])
      .rpc();

    const fetched = await program.account.job.fetch(job);
    expect(fetched.status).to.eq(3);
    expect(fetched.proofHash).to.deep.eq(hash32(9));
  });

  it("settle_job PASS sends done verdict", async () => {
    const claimer = Keypair.generate();
    const job = await initJob(new BN(1007), new BN(nowSec() + 600), 0);

    await program.methods
      .autoAssignJob(claimer.publicKey)
      .accountsPartial({ job, poster: poster.publicKey })
      .rpc();

    await program.methods
      .submitProof(hash32(7))
      .accountsPartial({
        job,
        submitter: claimer.publicKey,
      })
      .signers([claimer])
      .rpc();

    await program.methods
      .settleJob(1, hash32(1))
      .accountsPartial({
        job,
        settler: poster.publicKey,
        posterAccount: poster.publicKey,
        claimerAccount: claimer.publicKey,
      })
      .rpc();

    const fetched = await program.account.job.fetch(job);
    expect(fetched.status).to.eq(4);
  });

  it("settle_job FAIL sends failed verdict", async () => {
    const claimer = Keypair.generate();
    const job = await initJob(new BN(1008), new BN(nowSec() + 600), 0);

    await program.methods
      .autoAssignJob(claimer.publicKey)
      .accountsPartial({ job, poster: poster.publicKey })
      .rpc();

    await program.methods
      .submitProof(hash32(6))
      .accountsPartial({
        job,
        submitter: claimer.publicKey,
      })
      .signers([claimer])
      .rpc();

    await program.methods
      .settleJob(0, hash32(2))
      .accountsPartial({
        job,
        settler: poster.publicKey,
        posterAccount: poster.publicKey,
        claimerAccount: claimer.publicKey,
      })
      .rpc();

    const fetched = await program.account.job.fetch(job);
    expect(fetched.status).to.eq(5);
  });

  it("open_dispute opens dispute record for submitted verified job", async () => {
    const claimer = Keypair.generate();
    const challenger = Keypair.generate();
    await airdrop(challenger);
    const job = await initJob(new BN(1009), new BN(nowSec() + 600), 1);

    await program.methods
      .autoAssignJob(claimer.publicKey)
      .accountsPartial({ job, poster: poster.publicKey })
      .rpc();

    await program.methods
      .submitVerifiedProof(hash32(3), hash32(4), hash32(5), hash32(6))
      .accountsPartial({
        job,
        submitter: claimer.publicKey,
      })
      .signers([claimer])
      .rpc();

    const disputedThread = 42;
    const dispute = pdaDispute(job, disputedThread);
    await program.methods
      .openDispute(disputedThread, hash32(7), hash32(8))
      .accountsPartial({
        job,
        dispute,
        challenger: challenger.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([challenger])
      .rpc();

    const fetched = await program.account.disputeRecord.fetch(dispute);
    expect(fetched.job.toBase58()).to.eq(job.toBase58());
    expect(fetched.specHash).to.deep.eq(hash32(1));
    expect(fetched.disputedThread).to.eq(disputedThread);
    expect(fetched.status).to.eq(0);
  });

  it("expire_unclaimed expires job past deadline", async () => {
    const job = await initJob(new BN(1010), new BN(nowSec() + 1), 0);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await program.methods
      .expireUnclaimed()
      .accountsPartial({
        job,
        poster: poster.publicKey,
      })
      .rpc();

    const fetched = await program.account.job.fetch(job);
    expect(fetched.status).to.eq(5);
  });
});
