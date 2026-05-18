FROM mcr.microsoft.com/playwright:v1.48.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY services/ ./services/
COPY prompt/ ./prompt/
EXPOSE 3000
CMD ["node", "server.js"]
