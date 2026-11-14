# Tactics Tactics Practice Do Work

This folder owns tactics product action input builders for daily contests,
one-on-one contests, peer votes, season tournaments, and season results.

The builders write tactics product records plus generic prompt/evidence records
through workflow actions. Each action input carries `record_writes`, a list of
exact address/path/payload writes consumed by the generic workflow writer.
Season tournament opening writes a season config and the weekly prompt/evidence
records that the season projection reads.
