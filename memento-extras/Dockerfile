# Memento's extras service (AI edits, feature flags, ...). Built on the VM by Ansible
# (host/roles/memento_extras).
FROM node:24.22.2-alpine

ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY creations/src/job.ts ./creations/src/job.ts

# Not root, and not the image's "node" user (uid 1000): on the VM, uid 1000 is Oracle's
# built-in "opc" account, which would then own the data folder. 10001 is an ID no account
# on the VM has. /data is a folder on the VM owned by this ID.
USER 10001:10001
EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3005/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
