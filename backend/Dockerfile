# Build context is the repo root (see docker-compose.yml), so this
# Dockerfile can access both backend/ and db/ (schema.sql).
FROM node:20-alpine
WORKDIR /app
COPY backend/package*.json ./
RUN npm install
COPY backend/ .
COPY db/ /db/
EXPOSE 4000
CMD ["npm", "start"]
