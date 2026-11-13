# Read objects in an S3-compatible store

One container tool, `tool:read-objects-in-an-s3-store`: lists one page of a bucket, or reads one object, in an S3-compatible store the person connected (the Cloudflare R2 descriptor is in `tools/connect-a-service-and-seal-its-key/records.json`). Its input is the connection account id. The store's access key, secret, endpoint and bucket reach the run on private pipes (descriptors 3 to 6). Every request is signed with AWS Signature Version 4 and sent to that endpoint only.

`do-work/read-objects.mjs` holds the signing (`signRequest`, `signingKey`), the listing parse (`parseListing`) and `readObjects`. It reads only: no write and no delete. An object is returned as base64, up to 10 MiB.

Run the focused check from the repository root:

```
node --test tools/read-objects-in-an-s3-store/test/read-objects.test.mjs
```

The test is synthetic: a made-up endpoint and bucket, plus the published AWS signing example. It does not show that a live store accepts the request. That needs the person's connected store and the tool run through the door.
