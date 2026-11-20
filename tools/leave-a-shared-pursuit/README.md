# tools/leave-a-shared-pursuit

tool:leave-a-shared-pursuit is the port of the old leavePursuit for a person's pursuit that they share with other people. It marks the person's own membership of the pursuit's space left (through tool:leave-a-space's logic, space-members do-work/space-members.mjs leaveASpace) and ends the pursuit for them.

Guards kept from the old code (old repository commit 4ffa1dc4a2^:src/pursuit-rooms.mjs): G1 the pursuit must be the caller's own and not ended (ownPursuit, 184-190); G2 the person who runs the space cannot leave it (space-members do-work/space-members.mjs:59).

Not done here: the network's room leave (old pursuit-rooms.mjs:261) is not a row change. This tool changes only the caller's own rows.

NOT WIRED. No screen, route or wake calls this tool. The live wiring waits for the owner's word.

Tests: `node --test test/leave-a-shared-pursuit.test.mjs` (7 tests, two test people only: person:gate-test, a member, and person:gate-test-two, who runs the space).
