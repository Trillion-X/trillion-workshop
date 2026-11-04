// Loaded with --require into a row's run by test/at-the-size-of-a-real-list.test.mjs: on exit, the run's peak resident
// memory, on standard error, so a test can hold it to the row's needs.memory_mb.
process.on('exit', () => process.stderr.write(`\npeak_rss_kb ${process.resourceUsage().maxRSS}\n`));
