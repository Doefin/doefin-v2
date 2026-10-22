/*
 * ORC-001 PoC — one-off CPU miner for the attacker's single real-work header H1.
 *
 * Not used by the test suite at run time: the result is committed in
 * attacker-h1.json, and the contract itself re-derives H1's hash and re-checks
 * its proof of work on every test run. This file only documents how H1 was found
 * so anyone can reproduce it.
 *
 * Build (Apple Silicon / any ARMv8 with the SHA-2 extension):
 *   cc -O3 -march=armv8-a+crypto -pthread mine-h1.c -o mine-h1
 * Run:
 *   ./mine-h1 <80-byte header hex, nonce ignored> <target hex, 64 chars, big-endian> [threads]
 *
 * Searches the 2^32 nonce space; if exhausted, increments the header timestamp
 * (an extranonce — the oracle checks only that it is >= the 11-block median) and
 * searches again. Accepts a hash strictly below the target (the oracle's `<`).
 * Prints: timestampOffset nonce blockHash(display order).
 */
#include <arm_neon.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
static const uint32_t IV[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                               0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};

/* One SHA-256 compression; message given as 4 vectors of big-endian-decoded words. */
static inline void compress_w(uint32_t st[8], uint32x4_t m0, uint32x4_t m1, uint32x4_t m2, uint32x4_t m3) {
    uint32x4_t abcd = vld1q_u32(st), efgh = vld1q_u32(st + 4);
    const uint32x4_t abcd0 = abcd, efgh0 = efgh;
    uint32x4_t m[4] = {m0, m1, m2, m3};
#pragma unroll
    for (int i = 0; i < 16; i++) {
        uint32x4_t wk = vaddq_u32(m[i & 3], vld1q_u32(K + 4 * i));
        uint32x4_t a_prev = abcd;
        abcd = vsha256hq_u32(abcd, efgh, wk);
        efgh = vsha256h2q_u32(efgh, a_prev, wk);
        if (i < 12) m[i & 3] = vsha256su1q_u32(vsha256su0q_u32(m[i & 3], m[(i + 1) & 3]), m[(i + 2) & 3], m[(i + 3) & 3]);
    }
    vst1q_u32(st, vaddq_u32(abcd, abcd0));
    vst1q_u32(st + 4, vaddq_u32(efgh, efgh0));
}

static inline uint32x4_t load_be(const uint8_t *p) { return vreinterpretq_u32_u8(vrev32q_u8(vld1q_u8(p))); }

static void compress_bytes(uint32_t st[8], const uint8_t blk[64]) {
    compress_w(st, load_be(blk), load_be(blk + 16), load_be(blk + 32), load_be(blk + 48));
}

/* Double SHA-256 of an 80-byte header given the midstate of its first 64 bytes. */
static inline void dsha_tail(const uint32_t mid[8], const uint8_t tail16[16], uint32_t out[8]) {
    uint8_t blk[64] = {0};
    memcpy(blk, tail16, 16);
    blk[16] = 0x80;
    blk[62] = 0x02; /* 640 bits = 0x280 */
    blk[63] = 0x80;
    uint32_t s1[8];
    memcpy(s1, mid, 32);
    compress_bytes(s1, blk);
    uint32_t pad2[4] = {0x80000000u, 0, 0, 0}, len2[4] = {0, 0, 0, 256};
    memcpy(out, IV, 32);
    compress_w(out, vld1q_u32(s1), vld1q_u32(s1 + 4), vld1q_u32(pad2), vld1q_u32(len2));
}

/* Display-order (big-endian) hash bytes from the final state words. */
static void display_hash(const uint32_t st[8], uint8_t out[32]) {
    uint8_t d[32];
    for (int i = 0; i < 8; i++) {
        d[4 * i] = st[i] >> 24; d[4 * i + 1] = st[i] >> 16; d[4 * i + 2] = st[i] >> 8; d[4 * i + 3] = st[i];
    }
    for (int i = 0; i < 32; i++) out[i] = d[31 - i];
}

static int hex2bin(const char *hex, uint8_t *out, size_t n) {
    if (strlen(hex) != 2 * n) return -1;
    for (size_t i = 0; i < n; i++) {
        unsigned v;
        if (sscanf(hex + 2 * i, "%2x", &v) != 1) return -1;
        out[i] = (uint8_t)v;
    }
    return 0;
}

static uint8_t g_header[80];
static uint8_t g_target[32];
static uint32_t g_mid[8];
static uint32_t g_base_ts;
static uint32_t g_ts_off;
static int g_threads;
static atomic_int g_found;
static uint32_t g_found_nonce;
static uint8_t g_found_hash[32];
static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;

static void *worker(void *arg) {
    long t = (long)arg;
    uint64_t span = (1ULL << 32) / (uint64_t)g_threads;
    uint64_t lo = span * (uint64_t)t, hi = (t == g_threads - 1) ? (1ULL << 32) : lo + span;
    uint8_t tail[16];
    memcpy(tail, g_header + 64, 16);
    uint32_t ts = g_base_ts + g_ts_off;
    tail[4] = ts; tail[5] = ts >> 8; tail[6] = ts >> 16; tail[7] = ts >> 24;
    uint32_t st[8];
    for (uint64_t n = lo; n < hi; n++) {
        if ((n & 0xfffff) == 0 && atomic_load(&g_found)) return NULL;
        uint32_t nonce = (uint32_t)n;
        tail[12] = nonce; tail[13] = nonce >> 8; tail[14] = nonce >> 16; tail[15] = nonce >> 24;
        dsha_tail(g_mid, tail, st);
        if (st[7] != 0) continue; /* display hash's top 32 bits must be zero for any target <= 2^224 */
        uint8_t h[32];
        display_hash(st, h);
        if (memcmp(h, g_target, 32) < 0) {
            pthread_mutex_lock(&g_mu);
            if (!atomic_load(&g_found)) {
                g_found_nonce = nonce;
                memcpy(g_found_hash, h, 32);
                atomic_store(&g_found, 1);
            }
            pthread_mutex_unlock(&g_mu);
            return NULL;
        }
    }
    return NULL;
}

static int self_test(void) {
    /* Bitcoin genesis header -> 000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f */
    const char *gen =
        "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";
    uint8_t hdr[80], h[32], exp[32];
    hex2bin(gen, hdr, 80);
    hex2bin("000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", exp, 32);
    uint32_t mid[8], st[8];
    memcpy(mid, IV, 32);
    compress_bytes(mid, hdr);
    dsha_tail(mid, hdr + 64, st);
    display_hash(st, h);
    return memcmp(h, exp, 32) == 0 ? 0 : -1;
}

int main(int argc, char **argv) {
    if (self_test() != 0) { fprintf(stderr, "SHA-256 self-test FAILED\n"); return 2; }
    if (argc < 3 || hex2bin(argv[1], g_header, 80) || hex2bin(argv[2], g_target, 32)) {
        fprintf(stderr, "usage: %s <header80hex> <target64hex> [threads]\n", argv[0]);
        return 1;
    }
    g_threads = argc > 3 ? atoi(argv[3]) : 16;
    memcpy(g_mid, IV, 32);
    compress_bytes(g_mid, g_header);
    g_base_ts = (uint32_t)g_header[68] | ((uint32_t)g_header[69] << 8) | ((uint32_t)g_header[70] << 16) | ((uint32_t)g_header[71] << 24);
    for (g_ts_off = 0; g_ts_off < 1000; g_ts_off++) {
        pthread_t th[256];
        atomic_store(&g_found, 0);
        for (long t = 0; t < g_threads; t++) pthread_create(&th[t], NULL, worker, (void *)t);
        for (long t = 0; t < g_threads; t++) pthread_join(th[t], NULL);
        if (atomic_load(&g_found)) {
            printf("%u %u ", g_ts_off, g_found_nonce);
            for (int i = 0; i < 32; i++) printf("%02x", g_found_hash[i]);
            printf("\n");
            return 0;
        }
        fprintf(stderr, "timestamp offset %u: nonce space exhausted\n", g_ts_off);
    }
    return 1;
}
