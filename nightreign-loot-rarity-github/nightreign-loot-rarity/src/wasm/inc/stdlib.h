#ifndef NR_STDLIB_H
#define NR_STDLIB_H
#include <stddef.h>
void *malloc(size_t n);
void *calloc(size_t n, size_t s);
void free(void *p);
void qsort(void *base, size_t n, size_t sz, int (*cmp)(const void *, const void *));
int abs(int x);
#endif
