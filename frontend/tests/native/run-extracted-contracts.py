#!/usr/bin/env python3
"""Compile actual dependency-free Rust test blocks and session cleanup policy.
Not a full Tauri compile or device test. No rewritten stand-in implementation.
"""
from pathlib import Path
import subprocess,tempfile
root=Path(__file__).resolve().parents[2]/'src-tauri'
mod=(root/'src/auto_record/mod.rs').read_text()
start=mod.index('#[cfg(test)]\nmod post_processing_contract_tests')
end=mod.index('/// Emit a status event',start)
block=mod[start:end]
assert '#[test]' in block, 'empty extracted contracts'
with tempfile.TemporaryDirectory() as temp:
    Path(temp,'contracts.rs').write_text(block)
    subprocess.run(['docker','run','--rm','-v',f'{temp}:/tests:ro','-v',f'{root}:/source:ro','-e','CARGO_MANIFEST_DIR=/source','rust:1.85-slim','sh','-c','rustc --edition=2021 --test /tests/contracts.rs -o /tmp/tests && /tmp/tests'],check=True)
