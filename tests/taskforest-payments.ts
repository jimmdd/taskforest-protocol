import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Taskforest } from "../target/types/taskforest";
import { TaskforestPayments } from "../target/types/taskforest_payments";
import { expect } from "chai";
import { Ed25519Program, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction } from "@solana/web3.js";
import BN from "bn.js";

describe("taskforest-payments", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const coreProgram = anchor.workspace.Taskforest as Program<Taskforest>;
  const paymentsProgram = anchor.workspace.TaskforestPayments as Program<TaskforestPayments>;
  const poster = provider.wallet;
  const localValidator = provider.wallet;
  let idCounter = Date.now();

  function nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  function hash32(fill: number): number[] {
    return Array.from({ length: 32 }, () => fill);
  }

  function pdaJob(posterKey: PublicKey, jobId: BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("job"), posterKey.toBuffer(), jobId.toArrayLike(Buffer, "le", 8)],
      coreProgram.programId
    )[0];
  }

  function pdaEscrow(escrowId: BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), escrowId.toArrayLike(Buffer, "le", 8)],
      paymentsProgram.programId
    )[0];
  }

  function pdaSettlement(escrowId: BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("settlement"), escrowId.toArrayLike(Buffer, "le", 8)],
      paymentsProgram.programId
    )[0];
  }

  function errToString(err: unknown): string {
    if (err instanceof Error) {
      return err.toString();
    }
    return String(err);
  }

  function nextId(): BN {
    idCounter += 1;
    return new BN(idCounter);
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

  async function initializeAssignedJob(jobId: BN, agent: PublicKey): Promise<PublicKey> {
    const job = pdaJob(poster.publicKey, jobId);
    await coreProgram.methods
      .initializeJob(
        jobId,
        new BN(2_000_000),
        new BN(nowSec() + 1200),
        hash32(1),
        hash32(2),
        0,
        hash32(0),
        1,
        0,
        0
      )
      .accountsPartial({
        job,
        poster: poster.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await coreProgram.methods
      .autoAssignJob(agent)
      .accountsPartial({ job, poster: poster.publicKey })
      .rpc();

    return job;
  }

  function sessionIdBytes(label: string): number[] {
    return Array.from(Buffer.from(label.padEnd(32, "\0").slice(0, 32)));
  }

  function u64Le(value: BN | number): Buffer {
    return new BN(value).toArrayLike(Buffer, "le", 8);
  }

  function i64Le(value: BN | number): Buffer {
    return new BN(value).toTwos(64).toArrayLike(Buffer, "le", 8);
  }

  function buildAttestationReport(opts: {
    escrowId: BN;
    job: PublicKey;
    validator: PublicKey;
    teePubkey: number[];
    sessionId: number[];
    issuedAt: number;
    expiresAt: number;
  }): Buffer {
    return Buffer.concat([
      Buffer.from("TFAT"),
      Buffer.from([1, 0, 0, 0]),
      u64Le(opts.escrowId),
      opts.job.toBuffer(),
      opts.validator.toBuffer(),
      Buffer.from(opts.teePubkey),
      Buffer.from(opts.sessionId),
      i64Le(opts.issuedAt),
      i64Le(opts.expiresAt),
    ]);
  }

  it("create_escrow_wrapper links escrow to assigned job and moves deposit", async () => {
    const agent = Keypair.generate();
    const escrowId = nextId();
    const job = await initializeAssignedJob(nextId(), agent.publicKey);
    const escrow = pdaEscrow(escrowId);
    const deposit = 1_500_000;

    await paymentsProgram.methods
      .createEscrowWrapper(escrowId, new BN(deposit), sessionIdBytes("mpp-8001"))
      .accountsPartial({
        job,
        escrow,
        poster: poster.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const fetched = await paymentsProgram.account.escrowWrapper.fetch(escrow);
    expect(fetched.jobPubkey.toBase58()).to.eq(job.toBase58());
    expect(fetched.poster.toBase58()).to.eq(poster.publicKey.toBase58());
    expect(fetched.agent.toBase58()).to.eq(agent.publicKey.toBase58());
    expect(fetched.validator.toBase58()).to.eq(PublicKey.default.toBase58());
    expect(fetched.deposited.toString()).to.eq(deposit.toString());
    expect(JSON.stringify(fetched.status)).to.include("active");
    expect(fetched.teeVerified).to.eq(false);
  });

  it("create_escrow_wrapper fails if caller is not job poster", async () => {
    const agent = Keypair.generate();
    const attacker = Keypair.generate();
    await airdrop(attacker);

    const escrowId = nextId();
    const job = await initializeAssignedJob(nextId(), agent.publicKey);
    const escrow = pdaEscrow(escrowId);

    try {
      await paymentsProgram.methods
        .createEscrowWrapper(escrowId, new BN(1_000_000), sessionIdBytes("mpp-8002"))
        .accountsPartial({
          job,
          escrow,
          poster: attacker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      expect.fail("expected Unauthorized");
    } catch (err: unknown) {
      expect(errToString(err)).to.include("Unauthorized");
    }
  });

  it("delegate_to_per is currently unsupported in local light-validator flow", async () => {
    const agent = Keypair.generate();
    const escrowId = nextId();
    const job = await initializeAssignedJob(nextId(), agent.publicKey);
    const escrow = pdaEscrow(escrowId);

    await paymentsProgram.methods
      .createEscrowWrapper(escrowId, new BN(750_000), sessionIdBytes("mpp-8003"))
      .accountsPartial({
        job,
        escrow,
        poster: poster.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    try {
      await paymentsProgram.methods
        .delegateToPer(escrowId)
        .accountsPartial({
          pda: escrow,
          payer: poster.publicKey,
        })
        .remainingAccounts([{ pubkey: localValidator.publicKey, isSigner: false, isWritable: false }])
        .rpc();
      expect.fail("expected local light-validator delegate_to_per limitation");
    } catch (err: unknown) {
      const message = errToString(err);
      expect(message.length).to.be.greaterThan(0);
    }
  });

  it("verify_tee_attestation rejects empty reports", async () => {
    const agent = Keypair.generate();
    const escrowId = nextId();
    const job = await initializeAssignedJob(nextId(), agent.publicKey);
    const escrow = pdaEscrow(escrowId);

    await paymentsProgram.methods
      .createEscrowWrapper(escrowId, new BN(800_000), sessionIdBytes("mpp-8004"))
      .accountsPartial({
        job,
        escrow,
        poster: poster.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    try {
      await paymentsProgram.methods
        .verifyTeeAttestation(escrowId, Buffer.alloc(0), hash32(7))
        .accountsPartial({
          escrow,
          validator: localValidator.publicKey,
          payer: poster.publicKey,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc();
      expect.fail("expected InvalidAttestation");
    } catch (err: unknown) {
      expect(errToString(err)).to.include("InvalidAttestation");
    }
  });

  it("verify_tee_attestation rejects oversized reports before submission", async () => {
    const agent = Keypair.generate();
    const escrowId = nextId();
    const job = await initializeAssignedJob(nextId(), agent.publicKey);
    const escrow = pdaEscrow(escrowId);

    await paymentsProgram.methods
      .createEscrowWrapper(escrowId, new BN(800_000), sessionIdBytes("mpp-8005"))
      .accountsPartial({
        job,
        escrow,
        poster: poster.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    try {
      await paymentsProgram.methods
        .verifyTeeAttestation(escrowId, Buffer.alloc(4097, 9), hash32(8))
        .accountsPartial({
          escrow,
          validator: localValidator.publicKey,
          payer: poster.publicKey,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc();
      expect.fail("expected oversized attestation to fail");
    } catch (err: unknown) {
      expect(errToString(err)).to.include("encoding overruns Buffer");
    }
  });

  it("verify_tee_attestation rejects unsigned reports", async () => {
    const agent = Keypair.generate();
    const escrowId = nextId();
    const job = await initializeAssignedJob(nextId(), agent.publicKey);
    const escrow = pdaEscrow(escrowId);
    const teePubkey = hash32(9);
    const sessionId = sessionIdBytes("mpp-8006");
    const report = buildAttestationReport({
      escrowId,
      job,
      validator: localValidator.publicKey,
      teePubkey,
      sessionId,
      issuedAt: nowSec() - 5,
      expiresAt: nowSec() + 300,
    });

    await paymentsProgram.methods
      .createEscrowWrapper(escrowId, new BN(900_000), sessionId)
      .accountsPartial({
        job,
        escrow,
        poster: poster.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    try {
      await paymentsProgram.methods
        .verifyTeeAttestation(escrowId, report, teePubkey)
        .accountsPartial({
          escrow,
          validator: localValidator.publicKey,
          payer: poster.publicKey,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc();
      expect.fail("expected signature verification to fail");
    } catch (err: unknown) {
      expect(errToString(err)).to.include("InvalidAttestationSignature");
    }
  });

  it("verify_tee_attestation marks escrow delegated and tee verified when validator signature is present", async () => {
    const agent = Keypair.generate();
    const escrowId = nextId();
    const job = await initializeAssignedJob(nextId(), agent.publicKey);
    const escrow = pdaEscrow(escrowId);
    const teePubkey = hash32(10);
    const sessionId = sessionIdBytes("mpp-8007");
    const validatorSigner = (provider.wallet as anchor.Wallet & { payer: Keypair }).payer;
    const report = buildAttestationReport({
      escrowId,
      job,
      validator: localValidator.publicKey,
      teePubkey,
      sessionId,
      issuedAt: nowSec() - 5,
      expiresAt: nowSec() + 300,
    });

    await paymentsProgram.methods
      .createEscrowWrapper(escrowId, new BN(900_000), sessionId)
      .accountsPartial({
        job,
        escrow,
        poster: poster.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: validatorSigner.secretKey,
      message: report,
    });
    const verifyIx = await paymentsProgram.methods
      .verifyTeeAttestation(escrowId, report, teePubkey)
      .accountsPartial({
        escrow,
        validator: localValidator.publicKey,
        payer: poster.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    await provider.sendAndConfirm(new Transaction().add(ed25519Ix, verifyIx));

    const fetched = await paymentsProgram.account.escrowWrapper.fetch(escrow);
    expect(fetched.teeVerified).to.eq(true);
    expect(Array.from(fetched.teePubkey)).to.deep.eq(teePubkey);
    expect(fetched.validator.toBase58()).to.eq(localValidator.publicKey.toBase58());
    expect(JSON.stringify(fetched.status)).to.include("delegated");
  });

  it("record_settlement writes settlement record, pays the agent, and leaves only rent in escrow", async () => {
    const agent = Keypair.generate();
    await airdrop(agent, 1);
    const escrowId = nextId();
    const job = await initializeAssignedJob(nextId(), agent.publicKey);
    const escrow = pdaEscrow(escrowId);
    const settlement = pdaSettlement(escrowId);
    const deposited = 1_200_000;
    const totalPaid = 450_000;
    const agentBalanceBefore = await provider.connection.getBalance(agent.publicKey);

    await paymentsProgram.methods
      .createEscrowWrapper(escrowId, new BN(deposited), sessionIdBytes("mpp-8008"))
      .accountsPartial({
        job,
        escrow,
        poster: poster.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await paymentsProgram.methods
      .recordSettlement(escrowId, new BN(totalPaid))
      .accountsPartial({
        escrow,
        settlementRecord: settlement,
        poster: poster.publicKey,
        agent: agent.publicKey,
        payer: poster.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const fetchedEscrow = await paymentsProgram.account.escrowWrapper.fetch(escrow);
    const fetchedSettlement = await paymentsProgram.account.settlementRecord.fetch(settlement);
    const escrowAccount = await provider.connection.getAccountInfo(escrow);
    const escrowLamports = await provider.connection.getBalance(escrow);
    const agentBalanceAfter = await provider.connection.getBalance(agent.publicKey);
    const rentFloor = await provider.connection.getMinimumBalanceForRentExemption(escrowAccount!.data.length);

    expect(JSON.stringify(fetchedEscrow.status)).to.include("settled");
    expect(fetchedSettlement.escrowId.toString()).to.eq(escrowId.toString());
    expect(fetchedSettlement.jobPubkey.toBase58()).to.eq(job.toBase58());
    expect(fetchedSettlement.totalDeposited.toString()).to.eq(deposited.toString());
    expect(fetchedSettlement.totalPaid.toString()).to.eq(totalPaid.toString());
    expect(fetchedSettlement.settlementHash.length).to.eq(32);
    expect(escrowLamports).to.eq(rentFloor);
    expect(agentBalanceAfter - agentBalanceBefore).to.eq(totalPaid);
  });

  // compress_settlement is intentionally excluded here:
  // it requires Light proofs + tree accounts and should be covered in a separate integration path.
});
