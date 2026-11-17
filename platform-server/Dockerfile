FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json server.mjs common.mjs storage.mjs workflow.mjs connectors.mjs local-devices.mjs permissions.mjs jira-reference.mjs accounts.mjs ./
ENV TASKFLOW_HOST=0.0.0.0 TASKFLOW_PORT=5187 TASKFLOW_DB_PATH=/data/platform.sqlite
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 5187
CMD ["node", "server.mjs"]
