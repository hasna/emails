# Deployment cutover

This repository intentionally has no automatic deployment workflow. Merging or
tagging the repository cannot publish a package, push an image, or update AWS.

Before a future `workflow_dispatch` deployment is introduced, an operator must
provide an Emails-owned infrastructure manifest and least-privilege role in the
target user's AWS account. The workflow must use `APP=emails`, require an
explicit environment approval, and must not contain a Hasna account ID, bucket,
cluster, database URL, secret path, or default endpoint.

Rename cutover is additive: released Mailery migration ids/checksums and the
old API key remain valid during the rollback window. Apply the Emails bridge,
mint a new key with `emails self-hosted key rotate`, move and verify clients,
then revoke the old key explicitly. Do not delete or rewrite historical
migration-ledger rows.
