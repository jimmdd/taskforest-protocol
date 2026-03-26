import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL, Keypair, Connection } from "@solana/web3.js";
import * as fs from "fs";

const TASKFOREST_ID = new PublicKey("Fgiye795epSDkytp6a334Y2AwjqdGDecWV24yc2neZ4s");
const PAYMENTS_ID = new PublicKey("4hNP2tU5r5GgyASTrou84kWHbCwdyXVJJN4mve99rjgs");
const JOB_SEED = Buffer.from("job");
const ESCROW_SEED = Buffer.from("escrow");
const SETTLEMENT_SEED = Buffer.from("settlement");

async function main() {
  const keyData = JSON.parse(fs.readFileSync("keys/taskforest.json", "utf-8"));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(keyData));
  console.log("Wallet:", wallet.publicKey.toBase58());

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const balance = await connection.getBalance(wallet.publicKey);
  console.log("Balance:", balance / LAMPORTS_PER_SOL, "SOL");

  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed" }
  );

  const tfIdl = JSON.parse(fs.readFileSync("target/idl/taskforest.json", "utf-8"));
  const payIdl = JSON.parse(fs.readFileSync("target/idl/taskforest_payments.json", "utf-8"));
  const taskforest = new Program(tfIdl, provider);
  const payments = new Program(payIdl, provider);

  const jobId = Math.floor(Math.random() * 1_000_000_000);
  const escrowId = jobId + 1;
  const jobIdBuf = new anchor.BN(jobId).toArrayLike(Buffer, "le", 8);
  const escrowIdBuf = new anchor.BN(escrowId).toArrayLike(Buffer, "le", 8);

  // PDA derivation — include poster key in seeds (matches on-chain)
  const [jobPda] = PublicKey.findProgramAddressSync(
    [JOB_SEED, wallet.publicKey.toBuffer(), jobIdBuf],
    TASKFOREST_ID
  );
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [ESCROW_SEED, escrowIdBuf],
    PAYMENTS_ID
  );
  const [settlementPda] = PublicKey.findProgramAddressSync(
    [SETTLEMENT_SEED, escrowIdBuf],
    PAYMENTS_ID
  );

  console.log("\n--- Step 1: Create Job ---");
  console.log("Job PDA:", jobPda.toBase58());
  try {
    const jobTx = await taskforest.methods
      .initializeJob(
        new anchor.BN(jobId),
        new anchor.BN(0.01 * LAMPORTS_PER_SOL),
        new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
        Array.from({ length: 32 }, () => 0),
        Array.from({ length: 32 }, () => 0),
        0,
        Array.from({ length: 32 }, () => 0),
        1,
        0,
        0,
      )
      .accountsPartial({ job: jobPda, poster: wallet.publicKey })
      .rpc();
    console.log("Job TX:", jobTx);

    const assignTx = await taskforest.methods
      .autoAssignJob(wallet.publicKey)
      .accountsPartial({ job: jobPda, poster: wallet.publicKey })
      .rpc();
    console.log("Assign TX:", assignTx);

    const jobAccount = await connection.getAccountInfo(jobPda);
    console.log("Job exists:", !!jobAccount, "size:", jobAccount?.data.length, "owner:", jobAccount?.owner.toBase58());
  } catch (e: any) {
    console.error("Job creation failed:", e.message || JSON.stringify(e));
    return;
  }

  console.log("\n--- Step 2: Create Escrow ---");
  console.log("Escrow PDA:", escrowPda.toBase58());
  const sessionIdBytes = Array.from(Buffer.from(`demo-${escrowId}`.padEnd(32, "\0").slice(0, 32)));
  try {
    const escrowTx = await payments.methods
      .createEscrowWrapper(
        new anchor.BN(escrowId),
        new anchor.BN(0.005 * LAMPORTS_PER_SOL),
        sessionIdBytes,
      )
      .accountsPartial({ job: jobPda, escrow: escrowPda, poster: wallet.publicKey })
      .rpc();
    console.log("Escrow TX:", escrowTx);

    const escrowAccount = await connection.getAccountInfo(escrowPda);
    console.log("Escrow exists:", !!escrowAccount, "size:", escrowAccount?.data.length);
  } catch (e: any) {
    console.error("Escrow creation failed:", e.message || JSON.stringify(e));
    return;
  }

  console.log("\n--- Step 3: Record Settlement ---");
  try {
    const settleTx = await payments.methods
      .recordSettlement(
        new anchor.BN(escrowId),
        new anchor.BN(0.003 * LAMPORTS_PER_SOL),
      )
      .accountsPartial({ escrow: escrowPda, poster: wallet.publicKey, agent: wallet.publicKey, payer: wallet.publicKey })
      .rpc();
    console.log("Settlement TX:", settleTx);

    const settlementAccount = await connection.getAccountInfo(settlementPda);
    console.log("Settlement exists:", !!settlementAccount, "size:", settlementAccount?.data.length);
  } catch (e: any) {
    console.error("Settlement failed:", e.message || JSON.stringify(e));
    return;
  }

  console.log("\n=== ALL STEPS PASSED ===");
}

main().catch(console.error);
