/* Minimal freestanding glue to run libzstd's compressor in WebAssembly. */
#include <stddef.h>
#define ZSTD_STATIC_LINKING_ONLY
#include "zstd.h"

extern unsigned char __heap_base;
static size_t heap_top = 0;

void *malloc(size_t n) {
  if (!heap_top) heap_top = (size_t)&__heap_base;
  size_t p = (heap_top + 15) & ~(size_t)15;
  size_t end = p + n;
  size_t cur = __builtin_wasm_memory_size(0) * 65536u;
  if (end > cur) {
    size_t pages = (end - cur + 65535u) / 65536u;
    if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return 0;
  }
  heap_top = end;
  return (void *)p;
}
void free(void *p) { (void)p; }
void *calloc(size_t n, size_t s) { void *p = malloc(n * s); if (p) __builtin_memset(p, 0, n * s); return p; }
void *memcpy(void *d, const void *s, size_t n) { __builtin_memcpy(d, s, n); return d; }
void *memmove(void *d, const void *s, size_t n) { __builtin_memmove(d, s, n); return d; }
void *memset(void *p, int v, size_t n) { __builtin_memset(p, v, n); return p; }
int memcmp(const void *a, const void *b, size_t n) {
  const unsigned char *x = a, *y = b;
  for (size_t i = 0; i < n; i++) if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
size_t strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
int abs(int x) { return x < 0 ? -x : x; }

/* exported API */
void nr_reset(void) { heap_top = 0; }
void *nr_alloc(size_t n) { return malloc(n); }

ZSTD_CCtx *nr_create(int level, int windowLog) {
  ZSTD_CCtx *c = ZSTD_createCCtx();
  if (!c) return 0;
  if (ZSTD_isError(ZSTD_CCtx_setParameter(c, ZSTD_c_compressionLevel, level))) return 0;
  if (windowLog && ZSTD_isError(ZSTD_CCtx_setParameter(c, ZSTD_c_windowLog, windowLog))) return 0;
  if (ZSTD_isError(ZSTD_CCtx_setParameter(c, ZSTD_c_contentSizeFlag, 0))) return 0;
  if (ZSTD_isError(ZSTD_CCtx_setParameter(c, ZSTD_c_checksumFlag, 0))) return 0;
  return c;
}

/* pos[0] = input pos, pos[1] = output pos; returns ZSTD_compressStream2 result */
size_t nr_stream(ZSTD_CCtx *c, const void *src, size_t srcSize, void *dst, size_t dstCap, size_t *pos, int end) {
  ZSTD_inBuffer in = { src, srcSize, pos[0] };
  ZSTD_outBuffer out = { dst, dstCap, pos[1] };
  size_t r = ZSTD_compressStream2(c, &out, &in, end ? ZSTD_e_end : ZSTD_e_continue);
  pos[0] = in.pos; pos[1] = out.pos;
  return r;
}
/* Tell zstd the total size up front so it tunes itself exactly like one-shot compression
   (the size is still not written into the frame because contentSizeFlag = 0). */
size_t nr_pledge(ZSTD_CCtx *c, unsigned long long size) { return ZSTD_CCtx_setPledgedSrcSize(c, size); }
unsigned nr_is_error(size_t r) { return ZSTD_isError(r); }
const char *nr_error_name(size_t r) { return ZSTD_getErrorName(r); }
unsigned nr_version(void) { return ZSTD_versionNumber(); }
