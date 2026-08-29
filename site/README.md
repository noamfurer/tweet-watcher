# TweetDeckBHA on Netlify

Private X monitoring board deployed on Netlify. The browser never receives storage credentials. Board data is encrypted with AES-256-GCM before it is written to a private Netlify Blobs store.

Runtime credentials and the password hash are stored in the private Blobs store. No tracked query, password, encryption key, or storage credential is included in the repository or browser bundle.

The scheduled function runs every 15 minutes and only queues ingestion during the configured Israel activity windows.
