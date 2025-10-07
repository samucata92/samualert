
require("dotenv").config();
const fs = require("fs");
const fetch = require("node-fetch");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Connection, PublicKey } = require("@solana/web3.js");

const RPC = process.env.RPC || "https://api.mainnet-beta.solana.com";
const PORT = process.env.PORT || 3000;
const NOTIFIED_FILE = "notified.json";
const USERS_FILE = "users.json";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const connection = new Connection(RPC, "confirmed");
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

const app = express();
app.get("/", (req, res) => res.send("✅ Solana Mint Watcher attivo su Render"));
app.listen(PORT, () => console.log(`Server attivo su porta ${PORT}`));

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let users = [];
try {
  if (fs.existsSync(USERS_FILE)) users = JSON.parse(fs.readFileSync(USERS_FILE));
} catch (e) {
  console.error("Errore caricando users.json", e);
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!users.includes(chatId)) {
    users.push(chatId);
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    bot.sendMessage(chatId, "✅ Iscritto alle notifiche dei nuovi token Solana!");
  } else {
    bot.sendMessage(chatId, "⚡ Sei già iscritto!");
  }
});

async function sendTelegramMessage(message, image = null) {
  for (const chatId of users) {
    try {
      if (image) await bot.sendPhoto(chatId, image, { caption: message, parse_mode: "Markdown" });
      else await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("Errore Telegram:", e.message);
    }
  }
}

let notified = new Set();
try {
  if (fs.existsSync(NOTIFIED_FILE)) {
    notified = new Set(JSON.parse(fs.readFileSync(NOTIFIED_FILE)));
  }
} catch (e) {
  console.error("Errore caricando notified.json", e);
}

function saveNotified() {
  fs.writeFileSync(NOTIFIED_FILE, JSON.stringify([...notified], null, 2));
}

function buildExplorerLink(address) {
  return `https://explorer.solana.com/address/${address}?cluster=mainnet-beta`;
}

async function findMetadataPDA(mintPubkey) {
  const seeds = [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()];
  const [pda] = await PublicKey.findProgramAddress(seeds, METADATA_PROGRAM_ID);
  return pda;
}

async function fetchMetaplexMetadata(mint) {
  try {
    const mintPk = new PublicKey(mint);
    const pda = await findMetadataPDA(mintPk);
    const info = await connection.getAccountInfo(pda, "confirmed");
    if (!info?.data) return null;

    const dataStr = info.data.toString("utf8");
    const httpIndex = dataStr.indexOf("http");
    if (httpIndex < 0) return null;
    const uriMatch = dataStr.slice(httpIndex, httpIndex + 2000).match(/https?:\/\/[^"\0 ]+/);
    const uri = uriMatch ? uriMatch[0] : null;

    if (!uri) return null;
    const r = await fetch(uri);
    if (!r.ok) return null;
    const offchain = await r.json();
    if (!offchain?.name || !offchain?.symbol) return null;

    return { uri, offchain };
  } catch {
    return null;
  }
}

function isHotToken(topHolderPct) {
  return topHolderPct < 10;
}

async function handleSignature(sig) {
  try {
    const tx = await connection.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) return;

    for (const ix of tx.transaction.message.instructions || []) {
      if ((ix.program === "spl-token" || ix.programId?.toString() === TOKEN_PROGRAM_ID) && ix.parsed) {
        const type = ix.parsed.type;
        if (type === "initializeMint" || type === "initializeMint2") {
          const info = ix.parsed.info || {};
          const mint = info.mint || info.account;
          if (!mint || notified.has(mint)) return;

          const meta = await fetchMetaplexMetadata(mint);
          if (!meta) return;

          const name = meta.offchain.name;
          const symbol = meta.offchain.symbol;
          const image = meta.offchain.image || null;
          const explorer = buildExplorerLink(mint);

          let topHolderPct = 0;
          try {
            const largest = await connection.getTokenLargestAccounts(new PublicKey(mint));
            if (largest?.value?.length) {
              const top = largest.value[0];
              const total = largest.value.reduce((a, v) => a + Number(v.amount ?? 0), 0);
              if (total) topHolderPct = (Number(top.amount) / total) * 100;
            }
          } catch {}

          let msg = `🚨 *Nuovo Token Solana*\n`;
          msg += `• *Nome:* ${name}\n`;
          msg += `• *Simbolo:* ${symbol}\n`;
          msg += `• *Mint:* [${mint}](${explorer})\n`;
          msg += `• *Top holder:* ${topHolderPct.toFixed(2)}%\n`;

          if (isHotToken(topHolderPct)) msg = "🔥🚀💥 HOT TOKEN TROVATO 🔥🚀💥\n" + msg;

          await sendTelegramMessage(msg, image);
          notified.add(mint);
          saveNotified();
          console.log("✅ Token notificato:", name, symbol);
        }
      }
    }
  } catch (e) {
    console.error("Errore handleSignature:", e.message);
  }
}

connection.onLogs("all", async ({ signature, logs }) => {
  if (!logs || !signature) return;
  const joined = logs.join(" | ");
  if (joined.includes("InitializeMint")) {
    console.log("Nuovo InitializeMint:", signature);
    handleSignature(signature);
  }
});

console.log("🚀 Samu Alert Bot attivo!");
