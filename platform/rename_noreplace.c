/* Atomic directory publication without replacing an existing destination.
 * Linux renameat2 / macOS renamex_np. Windows directory rename is exclusive.
 * This helper contains no backup logic. SPDX-License-Identifier: Apache-2.0 */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#if defined(__linux__)
#include <unistd.h>
#include <sys/syscall.h>
#elif defined(__APPLE__)
#include <stdio.h>
#else
#error This helper is only needed on Linux and macOS
#endif

int main(int argc, char **argv) {
  if (argc != 3) { fputs("Expected source and destination\n", stderr); return 2; }
  int result;
#if defined(__linux__)
  result = (int)syscall(SYS_renameat2, AT_FDCWD, argv[1], AT_FDCWD, argv[2], 1 /* RENAME_NOREPLACE */);
#else
  result = renamex_np(argv[1], argv[2], RENAME_EXCL);
#endif
  if (result != 0) { fprintf(stderr, "Exclusive rename failed: %s\n", strerror(errno)); return 1; }
  return 0;
}
