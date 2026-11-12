# The browser image. The base is pinned by digest. Build context = this folder plus `chrome/`,
# a copy of Chrome for Testing (not committed: it is a 270 MB download, verify it against Google's checksum).
# Phase 1: hermes-browser:phase1-145 (Chrome 145.0.7632.6); socat added in the next build (see entrypoint.sh).
FROM debian@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 socat && rm -rf /var/lib/apt/lists/*
RUN useradd -u 10001 -m -d /home/browser -s /usr/sbin/nologin browser
COPY chrome /opt/chrome
# Readable by the unprivileged user, writable by nobody (the files arrive 0400 root-only otherwise).
RUN chmod -R a+rX,a-w /opt/chrome
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh
USER 10001
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
