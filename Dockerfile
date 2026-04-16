FROM apify/actor-node-playwright-chrome:18

COPY --chown=myuser package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "All npm packages installed"

COPY --chown=myuser . ./

CMD npm start --silent
