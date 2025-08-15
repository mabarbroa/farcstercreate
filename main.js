// Farcaster FID Register Bot (OP Mainnet) — log ke hasil.txt, PK ke wallets.csv (Mode Bulk)
// Node >=18

import 'dotenv/config';
import fs from 'fs';
import { createPublicClient, createWalletClient, http, formatEther } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { optimism } from 'viem/chains';
import {
  ID_GATEWAY_ADDRESS,
  idGatewayABI,
  ID_REGISTRY_ADDRESS,
  idRegistryABI,
} from '@farcaster/hub-nodejs';
import { ID_GATEWAY_EIP_712_TYPES } from '@farcaster/hub-web';

const OP_RPC = process.env.OP_RPC?.trim() || 'https://mainnet.optimism.io';
const EXTRA_UNITS = BigInt(process.env.EXTRA_UNITS ?? '0');
const DRY_RUN = /^1|true$/i.test(process.env.DRY_RUN || '');
const OUTPUT_FILE = process.env.OUTPUT_FILE?.trim() || 'hasil.txt';
const KEYS_FILE = process.env.KEYS_FILE?.trim() || 'wallets.csv';

// Bulk mode (Mode B)
const CREATE_COUNT = parseInt(process.env.CREATE_COUNT || '0', 10) || 0;
const PAYER_PK = process.env.PAYER_PK?.trim() || '';
const RECOVERY = (process.env.RECOVERY_ADDRESS?.trim()
  || '0x00000000FcB080a4D6c39a9354dA9EB9bC104cd7'); // Farcaster Recovery Proxy

// --- logging util ---
const now = () => new Date().toISOString();
const w = (s='') => fs.appendFileSync(OUTPUT_FILE, s + '\n', 'utf8');
const header = (title) => {
  fs.writeFileSync(
    OUTPUT_FILE,
    `=== ${title} ===\n` +
    `Waktu      : ${now()}\n` +
    `RPC        : ${OP_RPC}\n` +
    `Recovery   : ${RECOVERY}\n` +
    `ExtraUnits : ${EXTRA_UNITS}\n` +
    `Mode       : ${DRY_RUN ? 'DRY_RUN (no tx)' : 'LIVE'}\n`,
    'utf8'
  );
};
const initKeysFile = () => fs.writeFileSync(KEYS_FILE, 'index,address,private_key\n', 'utf8');
const writeKeyRow = (i, address, pk) =>
  fs.appendFileSync(KEYS_FILE, `${i},${address},${pk}\n`, 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

// --- clients ---
const transport = http(OP_RPC);
const publicClient = createPublicClient({ chain: optimism, transport });
const makeWalletClient = (account) => createWalletClient({ chain: optimism, transport, account });

function loadPKsFromFileOrEnv() {
  if (fs.existsSync('account.txt')) {
    return fs.readFileSync('account.txt', 'utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  }
  const envKeys = process.env.PRIVATE_KEYS || process.env.PRIVATE_KEY || '';
  return envKeys.split(/[\n,; ]+/).map(s=>s.trim()).filter(Boolean);
}

const readPrice = () => publicClient.readContract({
  address: ID_GATEWAY_ADDRESS, abi: idGatewayABI, functionName: 'price', args: [EXTRA_UNITS],
});
const getFidOf = (address) => publicClient.readContract({
  address: ID_REGISTRY_ADDRESS, abi: idRegistryABI, functionName: 'idOf', args: [address],
});

// --- Mode A: direct register() per PK ---
async function runRegisterList() {
  const PKS = loadPKsFromFileOrEnv();
  header('Farcaster FID Register Bot (Mode A: account.txt/env)');
  if (PKS.length === 0) { w('! Tidak ada PK. Isi account.txt atau set PRIVATE_KEYS/PRIVATE_KEY.'); console.error('Tidak ada PK. Lihat hasil.txt.'); process.exit(1); }
  w(`Wallets    : ${PKS.length}`);

  for (let i = 0; i < PKS.length; i++) {
    const pk = PKS[i].startsWith('0x') ? PKS[i] : `0x${PKS[i]}`;
    const acct = privateKeyToAccount(pk);
    const addr = acct.address;
    const walletClient = makeWalletClient(acct);
    w(`\n[${i+1}/${PKS.length}] ${addr}`);

    try {
      const fid = await getFidOf(addr);
      if (fid && fid > 0n) { w(`  ✓ Sudah punya FID: ${fid}`); continue; }
    } catch {}

    let price = 0n;
    try { price = await readPrice(); w(`  • Price: ${formatEther(price)} ETH (extraUnits=${EXTRA_UNITS})`); }
    catch (e) { w(`  ! Gagal price: ${e?.shortMessage || e?.message || e}`); continue; }
    if (DRY_RUN) { w('  (DRY_RUN) Skip tx'); continue; }

    try {
      const { request } = await publicClient.simulateContract({
        account: acct, address: ID_GATEWAY_ADDRESS, abi: idGatewayABI,
        functionName: 'register', args: [RECOVERY, EXTRA_UNITS], value: price,
      });
      const hash = await walletClient.writeContract(request);
      w(`  ⏳ Tx     : ${hash}`);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      w(`  ✓ Mined  : block ${rc.blockNumber}`);
      const newFid = await getFidOf(addr);
      w(`  🎉 FID    : ${newFid}`);
    } catch (e) {
      w(`  ✖ Error  : ${e?.shortMessage || e?.message || e}`);
    }

    if (i < PKS.length - 1) { const ms = rand(5000, 20000); w(`  … Delay  : ${Math.floor(ms/1000)}s`); await sleep(ms); }
  }
  w(`\n=== Selesai @ ${now()} ===`);
}

// --- Mode B: 1 payer -> create N wallets via registerFor() (PK ke wallets.csv) ---
async function runRegisterBulkWithPayer() {
  header('Farcaster FID Register Bot (Mode B: 1 PAYER -> N Wallet Baru)');
  w(`CreateCnt  : ${CREATE_COUNT}`);
  if (!PAYER_PK) { w('! PAYER_PK kosong. Set secret/env PAYER_PK untuk mode bulk.'); console.error('PAYER_PK kosong. Lihat hasil.txt.'); process.exit(1); }
  const payer = privateKeyToAccount(PAYER_PK.startsWith('0x') ? PAYER_PK : `0x${PAYER_PK}`);
  const payerClient = makeWalletClient(payer);
  w(`Payer      : ${payer.address}`);

  let price = 0n;
  try { price = await readPrice(); w(`• Price per akun: ${formatEther(price)} ETH (extraUnits=${EXTRA_UNITS})`); }
  catch (e) { w(`! Gagal price: ${e?.shortMessage || e?.message || e}`); return; }
  if (DRY_RUN) w('(DRY_RUN) Tidak mengirim tx, namun tetap generate wallet & tanda tangan).');

  // --- file PK terpisah
  initKeysFile();

  for (let i = 0; i < CREATE_COUNT; i++) {
    const newPk = generatePrivateKey();
    const toAcct = privateKeyToAccount(newPk);
    const to = toAcct.address;

    // Simpan PK ke wallets.csv, TIDAK ke hasil.txt
    writeKeyRow(i + 1, to, newPk);

    // Log singkat di hasil.txt
    w(`\n[${i+1}/${CREATE_COUNT}] ${to}`);

    // Baca nonce & siapkan deadline
    let nonce = 0n;
    try {
      nonce = await publicClient.readContract({
        address: ID_GATEWAY_ADDRESS, abi: idGatewayABI, functionName: 'nonces', args: [to],
      });
    } catch (e) { w(`  ! [${to}] Gagal nonce: ${e?.shortMessage || e?.message || e}`); continue; }
    const deadline = BigInt(Math.floor(Date.now()/1000) + 60*60); // 1 jam

    // Sign EIP-712 oleh calon pemilik (toAcct)
    let sig;
    try {
      sig = await toAcct.signTypedData({
        ...ID_GATEWAY_EIP_712_TYPES,
        primaryType: 'Register',
        message: { to, recovery: RECOVERY, nonce, deadline },
      });
    } catch (e) { w(`  ! [${to}] Gagal sign EIP-712: ${e?.shortMessage || e?.message || e}`); continue; }

    if (DRY_RUN) { w(`  (DRY_RUN) Skip tx for ${to}`); continue; }

    try {
      const { request } = await publicClient.simulateContract({
        account: payer, address: ID_GATEWAY_ADDRESS, abi: idGatewayABI,
        functionName: 'registerFor',
        args: [to, RECOVERY, deadline, sig, EXTRA_UNITS],
        value: price,
      });
      const hash = await payerClient.writeContract(request);
      w(`  ⏳ [${to}] Tx : ${hash}`);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      w(`  ✓ [${to}] Mined block ${rc.blockNumber}`);
      const fid = await getFidOf(to);
      w(`  🎉 [${to}] FID: ${fid}`);
    } catch (e) {
      w(`  ✖ [${to}] Error: ${e?.shortMessage || e?.message || e}`);
    }

    if (i < CREATE_COUNT - 1) { const ms = rand(5000, 20000); w(`  … Delay  : ${Math.floor(ms/1000)}s`); await sleep(ms); }
  }
  w(`\n=== Selesai @ ${now()} ===`);
}

(async () => {
  try {
    if (CREATE_COUNT > 0 && PAYER_PK) await runRegisterBulkWithPayer();
    else await runRegisterList();
    console.log('Selesai. Cek hasil.txt & wallets.csv (jika Mode Bulk).');
  } catch (e) {
    w(`FATAL: ${e?.shortMessage || e?.message || e}`);
    console.error('Gagal. Detail di hasil.txt');
    process.exit(1);
  }
})();
