FROM node:20-slim

# ffmpeg is required for stitching scene clips into the final video
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Render sets $PORT at runtime; server.js already reads process.env.PORT
EXPOSE 3000

CMD ["node", "server.js"]
