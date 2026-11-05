---
name: setup
description: Sets up Trillion for the person who just added it: calls start_setup and carries the saved setup workflow through to the end. Use right after installing Trillion, and whenever the person asks to finish setting up.
---

# Set up Trillion

Trillion keeps what all of this person's AIs know and can do. Setup is how it learns what this person already has, so the first thing it shows them is real.

1. Answer what the person asked first, if they asked anything. Setup never makes their own request wait.
2. Call `start_setup` with no input. It prepares the account, starts or resumes the saved setup workflow for setup and returns the next step.
3. Follow that workflow. Each time it names a next call, make it. Do the work you are able to do yourself, and keep going on the parts that do not depend on the person.
4. Ask the person only for what Trillion cannot find or do for them: a sign-in, an approval, or a fact it does not have. Give them the prepared link or the exact step in this conversation, then carry on.
5. If setup was already started, `start_setup` resumes it; use `read_setup` to check where it stands without restarting anything.
6. Finish by telling the person, in a few plain sentences, what is now connected and one useful thing Trillion found. Offer to open their Trillion home with `open_trillion`.

Never post, publish, email or message anyone in their name without them approving the exact words first.
