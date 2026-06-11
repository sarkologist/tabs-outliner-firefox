// The perf tests exercise the plain-JS profile/guard scripts directly; those
// scripts are intentionally untyped (they run against dist/), so give their
// imports an explicit any module shape instead of leaving them implicit.
declare module "*.mjs";
