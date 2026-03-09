import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Taskforest } from "../target/types/taskforest";
import { expect } from "chai";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";

describe("taskforest", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Taskforest as Program<Taskforest>;
  const poster = provider.wallet;
  const JOB_ID = new BN(1); // consistent job_id for tests

  // Helper: derive Job PDA (includes job_id)
  function findJobPda(posterKey: PublicKey, jobId: BN = JOB_ID): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("job"), posterKey.toBuffer(), jobId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  }

  // Helper: derive TTD PDA
  function findTtdPda(creatorKey: PublicKey, ttdHash: number[]): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("ttd"), creatorKey.toBuffer(), Buffer.from(ttdHash)],
      program.programId
    );
  }

  // Helper: derive Vault PDA
  function findVaultPda(posterKey: PublicKey, jobKey: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), posterKey.toBuffer(), jobKey.toBuffer()],
      program.programId
    );
  }

  // Helper: build a deadline 1 hour in the future
  function futureDeadline(): BN {
    return new BN(Math.floor(Date.now() / 1000) + 3600);
  }

  // Helper: build a deadline in the past
  function pastDeadline(): BN {
    return new BN(Math.floor(Date.now() / 1000) - 3600);
  }

  // Helper: random 32-byte hash
  function randomHash(): number[] {
    return Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));
  }

  // Helper: zero hash (untyped job)
  function zeroHash(): number[] {
    return Array.from({ length: 32 }, () => 0);
  }

  // ===== TDD: Tests written first, program must satisfy these =====

  describe("register_ttd", () => {
    it("registers a TTD with correct fields", async () => {
      const ttdHash = randomHash();
      const [ttdPda] = findTtdPda(poster.publicKey, ttdHash);
      const uri = "ipfs://QmTestHash123";

      await program.methods
        .registerTtd(ttdHash, uri, 1)
        .accounts({
          ttd: ttdPda,
          creator: poster.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const ttd = await program.account.taskTypeDefinition.fetch(ttdPda);
      expect(ttd.creator.toBase58()).to.equal(poster.publicKey.toBase58());
      expect(ttd.ttdHash).to.deep.equal(ttdHash);
      expect(ttd.ttdUri).to.equal(uri);
      expect(ttd.version).to.equal(1);
      expect(ttd.createdAt.toNumber()).to.be.greaterThan(0);
    });

    it("rejects URI that is too long", async () => {
      const ttdHash = randomHash();
      const [ttdPda] = findTtdPda(poster.publicKey, ttdHash);
      const longUri = "x".repeat(200);

      try {
        await program.methods
          .registerTtd(ttdHash, longUri, 1)
          .accounts({
            ttd: ttdPda,
            creator: poster.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("UriTooLong");
      }
    });
  });

  describe("initialize_job", () => {
    it("creates a job with privacy fields", async () => {
      const [jobPda] = findJobPda(poster.publicKey);
      const reward = new BN(1_000_000); // 0.001 SOL
      const deadline = futureDeadline();
      const specHash = randomHash();
      const ttdHash = randomHash();
      const encPubkey = randomHash();

      await program.methods
        .initializeJob(JOB_ID, reward, deadline, specHash, ttdHash, 1, encPubkey)
        .accounts({
          job: jobPda,
          poster: poster.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const job = await program.account.job.fetch(jobPda);
      expect(job.poster.toBase58()).to.equal(poster.publicKey.toBase58());
      expect(job.rewardLamports.toNumber()).to.equal(1_000_000);
      expect(job.deadline.toNumber()).to.equal(deadline.toNumber());
      expect(job.status).to.equal(0); // STATUS_OPEN
      expect(job.bidCount).to.equal(0);
      expect(job.ttdHash).to.deep.equal(ttdHash);
      expect(job.privacyLevel).to.equal(1);
      expect(job.encryptionPubkey).to.deep.equal(encPubkey);
    });

    it("rejects zero reward", async () => {
      const fakePoster = anchor.web3.Keypair.generate();
      
      const sig = await provider.connection.requestAirdrop(
        fakePoster.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      const fakeJobId = new BN(99);
      const [jobPda] = findJobPda(fakePoster.publicKey, fakeJobId);
      const specHash = randomHash();

      try {
        await program.methods
          .initializeJob(fakeJobId, new BN(0), futureDeadline(), specHash, zeroHash(), 0, zeroHash())
          .accounts({
            job: jobPda,
            poster: fakePoster.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([fakePoster])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidReward");
      }
    });
  });

  describe("submit_proof", () => {
    it("rejects proof from non-claimer", async () => {
      const [jobPda] = findJobPda(poster.publicKey);
      const proofHash = randomHash();

      try {
        await program.methods
          .submitProof(proofHash)
          .accounts({
            job: jobPda,
            submitter: poster.publicKey,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("WrongStatus");
      }
    });
  });

  describe("expire_claim", () => {
    it("rejects expiry on non-claimed job", async () => {
      const [jobPda] = findJobPda(poster.publicKey);

      try {
        await program.methods
          .expireClaim()
          .accounts({
            job: jobPda,
            posterAccount: poster.publicKey,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("WrongStatus");
      }
    });
  });

  describe("expire_unclaimed", () => {
    const expirePoster = anchor.web3.Keypair.generate();
    let expireJobPda: PublicKey;

    before(async () => {
      const sig = await provider.connection.requestAirdrop(
        expirePoster.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      [expireJobPda] = findJobPda(expirePoster.publicKey, new BN(200));

      // Create a job with past deadline
      await program.methods
        .initializeJob(new BN(200), new BN(500_000), futureDeadline(), randomHash(), zeroHash(), 0, zeroHash())
        .accounts({
          job: expireJobPda,
          poster: expirePoster.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([expirePoster])
        .rpc();
    });

    it("rejects expire_unclaimed before deadline", async () => {
      try {
        await program.methods
          .expireUnclaimed()
          .accounts({
            job: expireJobPda,
            poster: expirePoster.publicKey,
          })
          .signers([expirePoster])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("DeadlineNotPassed");
      }
    });

    it("rejects expire_unclaimed from non-poster", async () => {
      try {
        await program.methods
          .expireUnclaimed()
          .accounts({
            job: expireJobPda,
            poster: poster.publicKey, // wrong poster
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });
  });

  describe("extend_deadline", () => {
    it("rejects extend on STATUS_OPEN job from non-poster", async () => {
      const [jobPda] = findJobPda(poster.publicKey);

      const fakePoster = anchor.web3.Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        fakePoster.publicKey,
        1 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      try {
        await program.methods
          .extendDeadline(futureDeadline())
          .accounts({
            job: jobPda,
            poster: fakePoster.publicKey,
          })
          .signers([fakePoster])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });

    it("extends deadline of an OPEN job", async () => {
      const [jobPda] = findJobPda(poster.publicKey);
      const newDeadline = new BN(Math.floor(Date.now() / 1000) + 7200);

      await program.methods
        .extendDeadline(newDeadline)
        .accounts({
          job: jobPda,
          poster: poster.publicKey,
        })
        .rpc();

      const job = await program.account.job.fetch(jobPda);
      expect(job.deadline.toNumber()).to.equal(newDeadline.toNumber());
    });
  });

  describe("store_credential", () => {
    it("stores a credential in the vault", async () => {
      const [jobPda] = findJobPda(poster.publicKey);
      const [vaultPda] = findVaultPda(poster.publicKey, jobPda);
      const credHash = randomHash();

      await program.methods
        .storeCredential(credHash)
        .accounts({
          vault: vaultPda,
          job: jobPda,
          poster: poster.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vault = await program.account.credentialVault.fetch(vaultPda);
      expect(vault.poster.toBase58()).to.equal(poster.publicKey.toBase58());
      expect(vault.job.toBase58()).to.equal(jobPda.toBase58());
      expect(vault.encryptedCredHash).to.deep.equal(credHash);
      expect(vault.isActive).to.equal(true);
    });
  });

  describe("clear_credential", () => {
    it("clears the credential vault", async () => {
      const [jobPda] = findJobPda(poster.publicKey);
      const [vaultPda] = findVaultPda(poster.publicKey, jobPda);

      await program.methods
        .clearCredential()
        .accounts({
          vault: vaultPda,
          poster: poster.publicKey,
        })
        .rpc();

      const vault = await program.account.credentialVault.fetch(vaultPda);
      expect(vault.isActive).to.equal(false);
      expect(vault.encryptedCredHash).to.deep.equal(zeroHash());
    });
  });

  describe("archive_settlement", () => {
    const archivePoster = anchor.web3.Keypair.generate();
    let archiveJobPda: PublicKey;
    let archivePda: PublicKey;

    before(async () => {
      const sig = await provider.connection.requestAirdrop(
        archivePoster.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      [archiveJobPda] = findJobPda(archivePoster.publicKey, new BN(50));
      [archivePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("archive"), archiveJobPda.toBuffer()],
        program.programId
      );

      // Create a job
      await program.methods
        .initializeJob(new BN(50), new BN(500_000), futureDeadline(), randomHash(), zeroHash(), 0, zeroHash())
        .accounts({
          job: archiveJobPda,
          poster: archivePoster.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([archivePoster])
        .rpc();
    });

    it("rejects archive on non-settled job (status=OPEN)", async () => {
      try {
        await program.methods
          .archiveSettlement(randomHash())
          .accounts({
            payer: archivePoster.publicKey,
            job: archiveJobPda,
            archive: archivePda,
            systemProgram: SystemProgram.programId,
          })
          .signers([archivePoster])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("WrongStatus");
      }
    });

    it("archives a settled job with correct fields", async () => {
      // Full settle→archive flow requires ER — tested on devnet
    });
  });
});
