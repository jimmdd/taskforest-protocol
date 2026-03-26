import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import BN from "bn.js";

const TASKFOREST_ID = new PublicKey("Fgiye795epSDkytp6a334Y2AwjqdGDecWV24yc2neZ4s");
const PAYMENTS_ID = new PublicKey("4hNP2tU5r5GgyASTrou84kWHbCwdyXVJJN4mve99rjgs");
const MAGIC_ROUTER = "https://devnet-router.magicblock.app/";
const JOB_SEED = Buffer.from("job");
const ESCROW_SEED = Buffer.from("escrow");

function randomHash(fill: number): number[] {
  return Array.from({ length: 32 }, () => fill);
}

async function getDelegationEndpoint(pda: PublicKey): Promise<string | null> {
  const response = await fetch(MAGIC_ROUTER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getDelegationStatus",
      params: [pda.toBase58()],
    }),
  });
  const result = (await response.json()) as {
    result?: { isDelegated?: boolean; fqdn?: string };
    error?: unknown;
  };

  if (result.error) {
    throw new Error(`MagicBlock router error: ${JSON.stringify(result.error)}`);
  }
  if (result.result?.isDelegated && result.result.fqdn) {
    return result.result.fqdn;
  }
  return null;
}

async function waitForDelegation(pda: PublicKey, maxAttempts = 12, delayMs = 5000): Promise<string | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const endpoint = await getDelegationEndpoint(pda);
    if (endpoint) {
      return endpoint;
    }
    console.log(`Delegation not visible yet (${attempt}/${maxAttempts}), waiting ${delayMs / 1000}s...`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

async function main() {
  const keyData = JSON.parse(fs.readFileSync("keys/taskforest.json", "utf-8"));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(keyData));
  const rpcEndpoint = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpcEndpoint, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {
    commitment: "confirmed",
  });

  const tfIdl = JSON.parse(fs.readFileSync("target/idl/taskforest.json", "utf-8"));
  const payIdl = JSON.parse(fs.readFileSync("target/idl/taskforest_payments.json", "utf-8"));
  const taskforest = new Program(tfIdl, provider);
  const payments = new Program(payIdl, provider);

  const balance = await connection.getBalance(wallet.publicKey);
  console.log("RPC:", connection.rpcEndpoint);
  console.log("Wallet:", wallet.publicKey.toBase58());
  console.log("Balance:", balance / LAMPORTS_PER_SOL, "SOL");
  if (balance < 0.02 * LAMPORTS_PER_SOL) {
    throw new Error("Devnet wallet balance is too low for the payments delegation smoke test");
  }

  const jobId = Math.floor(Date.now() / 1000);
  const escrowId = jobId + 1;
  const jobIdBuf = new BN(jobId).toArrayLike(Buffer, "le", 8);
  const escrowIdBuf = new BN(escrowId).toArrayLike(Buffer, "le", 8);

  const [jobPda] = PublicKey.findProgramAddressSync(
    [JOB_SEED, wallet.publicKey.toBuffer(), jobIdBuf],
    TASKFOREST_ID
  );
  const [escrowPda] = PublicKey.findProgramAddressSync([ESCROW_SEED, escrowIdBuf], PAYMENTS_ID);

  console.log("\n--- Step 1: Create and assign job ---");
  console.log("Job PDA:", jobPda.toBase58());
  const jobTx = await taskforest.methods
    .initializeJob(
      new BN(jobId),
      new BN(0.01 * LAMPORTS_PER_SOL),
      new BN(Math.floor(Date.now() / 1000) + 3600),
      randomHash(1),
      randomHash(2),
      0,
      randomHash(0),
      1,
      0,
      0
    )
    .accountsPartial({
      job: jobPda,
      poster: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("Job TX:", jobTx);

  const assignTx = await taskforest.methods
    .autoAssignJob(wallet.publicKey)
    .accountsPartial({ job: jobPda, poster: wallet.publicKey })
    .rpc();
  console.log("Assign TX:", assignTx);

  console.log("\n--- Step 2: Create escrow wrapper ---");
  console.log("Escrow PDA:", escrowPda.toBase58());
  const sessionIdBytes = Array.from(Buffer.from(`per-${escrowId}`.padEnd(32, "\0").slice(0, 32)));
  const escrowTx = await payments.methods
    .createEscrowWrapper(new BN(escrowId), new BN(0.005 * LAMPORTS_PER_SOL), sessionIdBytes)
    .accountsPartial({
      job: jobPda,
      escrow: escrowPda,
      poster: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("Escrow TX:", escrowTx);

  console.log("\n--- Step 3: Delegate escrow to PER ---");
  const delegateTx = await payments.methods
    .delegateToPer(new BN(escrowId))
    .accountsPartial({
      pda: escrowPda,
      payer: wallet.publicKey,
    })
    .rpc();
  console.log("Delegate TX:", delegateTx);

  console.log("\n--- Step 4: Confirm router sees delegation ---");
  const endpoint = await waitForDelegation(escrowPda);
  if (!endpoint) {
    throw new Error("Delegation transaction landed, but MagicBlock router did not report the escrow as delegated");
  }
  console.log("Delegated endpoint:", endpoint);
  console.log("\n=== PAYMENTS PER DELEGATION PASSED ===");
}

describe("taskforest-payments — Devnet PER delegation", () => {
  it("delegates escrow to MagicBlock PER on devnet", async function () {
    this.timeout(120000);
    await main();
  });
});
