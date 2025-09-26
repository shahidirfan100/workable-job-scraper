FROM apify/actor-node-playwright-chrome:22-1.54.1

COPY --chown=myuser package*.json ./
RUN npm install --include=dev --audit=false

COPY --chown=myuser . ./

RUN npm run build

CMD ["npm", "start"]
