#!/usr/bin/env python3
from __future__ import annotations
"""Generate claude_vocab.bin from the ctoc vocab.json.

Downloads vocab.json from github.com/rohangpta/ctoc if not present locally,
then converts the verified token list into a compact binary format:
  [u16_le length][raw_utf8_bytes] for each token

Output: ../data/claude_vocab.bin
"""
import json
import struct
import sys
import urllib.request
from pathlib import Path

VOCAB_URL = "https://raw.githubusercontent.com/rohangpta/ctoc/main/vocab.json"
SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR.parent / "data"
VOCAB_JSON = DATA_DIR / "vocab.json"
VOCAB_BIN = DATA_DIR / "claude_vocab.bin"


def download_vocab():
    if VOCAB_JSON.exists():
        print(f"Using cached {VOCAB_JSON}", file=sys.stderr)
        return
    print(f"Downloading vocab from {VOCAB_URL}...", file=sys.stderr)
    urllib.request.urlretrieve(VOCAB_URL, VOCAB_JSON)
    print(f"Downloaded {VOCAB_JSON.stat().st_size:,} bytes", file=sys.stderr)


def convert_to_binary(tokens: list[str]) -> bytes:
    buf = bytearray()
    for token in tokens:
        encoded = token.encode("utf-8")
        if len(encoded) > 65535:
            print(f"WARNING: skipping token of length {len(encoded)}", file=sys.stderr)
            continue
        buf.extend(struct.pack("<H", len(encoded)))
        buf.extend(encoded)
    return bytes(buf)


def main():
    DATA_DIR.mkdir(exist_ok=True)
    download_vocab()

    with open(VOCAB_JSON, "r", encoding="utf-8") as f:
        data = json.load(f)

    tokens = data["verified"]
    print(f"Found {len(tokens)} verified tokens", file=sys.stderr)

    binary = convert_to_binary(tokens)
    VOCAB_BIN.write_bytes(binary)
    print(
        f"Wrote {VOCAB_BIN} ({len(binary):,} bytes, {len(tokens)} tokens)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
