# tools/read-glance-feeds/

The definitions of the glance feeds and surfaces: `read-data/glance-feeds.json` is DATA only. It names each surface, each feed, the record type a feed reads, its filters, order, shown parts and limits, and the feeds that are unavailable. Nothing in this folder reads a record.

Reading one feed or an ordered surface from the person's own rows is no longer a tool. It is the recipe `workflow:read-glance-feeds` (`tools/workflows/recipes/read-glance-feeds.json`): the person's AI reads these definitions, queries the rows of the record type each feed names in the person's own store, and answers each feed. The reader module, its command, its kit and its tests were removed in the landing commit (the store's rows are the store's, and the feed query is the store's own query).

The choice of a feed for each widget (`tools/choose-the-feed-each-widget-shows`) reads `read-data/glance-feeds.json` too. Two feeds, running and told, read through the packaged reader of the tell-the-person owner (readKeptNotices), which keeps its own rules.
