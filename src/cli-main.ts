#!/usr/bin/env node
import { runCli } from "./cli.js";

const baseUrl = process.env.PISTORAGE_URL?.trim() || "http://127.0.0.1:3700";
const apiKey = process.env.PISTORAGE_API_KEY?.trim() || undefined;

runCli(process.argv.slice(2), {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  baseUrl,
  apiKey
}).then((code) => {
  process.exitCode = code;
});
