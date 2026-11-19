FROM node:24-bookworm

RUN npm install -g @deepseek-ai/dsh@0.2.2-rc.5

COPY dsh/start.mjs /opt/dsh-e2e/start.mjs
ENV DSH_HOME=/tmp/dsh-home

ENTRYPOINT ["node", "/opt/dsh-e2e/start.mjs"]
