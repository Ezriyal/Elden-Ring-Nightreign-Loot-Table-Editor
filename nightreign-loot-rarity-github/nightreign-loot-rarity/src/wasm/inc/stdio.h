#ifndef NR_STDIO_H
#define NR_STDIO_H
typedef struct NR_FILE NR_FILE;
#define FILE NR_FILE
extern FILE *stderr;
int fprintf(FILE *f, const char *fmt, ...);
#endif
