#!/bin/sh
# Rebuilds ../nrzstd.wasm (libzstd 1.5.7 compressor) with clang + wasm-ld.
# zstd source: https://github.com/facebook/zstd tag v1.5.7 (copy of the needed files in ../zstd-1.5.7).
set -e
cd "$(dirname "$0")"
Z=../zstd-1.5.7/lib
SRCS="$Z/common/entropy_common.c $Z/common/error_private.c $Z/common/fse_decompress.c $Z/common/xxhash.c $Z/common/zstd_common.c $Z/common/debug.c $Z/compress/fse_compress.c $Z/compress/hist.c $Z/compress/huf_compress.c $Z/compress/zstd_compress.c $Z/compress/zstd_compress_literals.c $Z/compress/zstd_compress_sequences.c $Z/compress/zstd_compress_superblock.c $Z/compress/zstd_double_fast.c $Z/compress/zstd_fast.c $Z/compress/zstd_lazy.c $Z/compress/zstd_ldm.c $Z/compress/zstd_opt.c $Z/compress/zstd_preSplit.c"
clang --target=wasm32 -O2 -mbulk-memory -nostdlib -isystem inc -I$Z -I$Z/common \
  -DZSTD_TRACE=0 -DDEBUGLEVEL=0 -DZSTD_DISABLE_ASM -DZSTD_NO_INTRINSICS -DXXH_NAMESPACE=ZSTD_ \
  -Wl,--no-entry -Wl,--strip-all -Wl,--initial-memory=33554432 \
  -Wl,--export=nr_reset -Wl,--export=nr_alloc -Wl,--export=nr_create -Wl,--export=nr_pledge \
  -Wl,--export=nr_stream -Wl,--export=nr_is_error -Wl,--export=nr_error_name -Wl,--export=nr_version \
  -o ../nrzstd.wasm nrzstd.c $SRCS
