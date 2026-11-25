FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json *.mjs *.d.mts ./
COPY workbench-remote ./workbench-remote
RUN rm -f ./*.test.mjs ./workbench-remote/*.fixture.mjs
ENV TASKFLOW_HOST=127.0.0.1 TASKFLOW_PORT=5187 TASKFLOW_DB_PATH=/data/platform.sqlite TASKFLOW_DEPLOYMENT=server TASKFLOW_TRUST_PROXY=1
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 5187
CMD ["node", "server.mjs"]
