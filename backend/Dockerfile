# ============================================================
# Social Buster - Backend Dockerfile
# Base image: Node 20 on Alpine Linux (small, fast)
# ============================================================

FROM node:20-alpine

# Install FFmpeg with full codec support for video analysis and trimming.
# ffmpeg-libs adds H.265/HEVC, AAC variants, and other codecs needed for
# iPhone .mov files and other common formats that the base ffmpeg package misses.
RUN apk add --no-cache ffmpeg ffmpeg-libs

# Set working directory inside the container
WORKDIR /app

# Copy package files FIRST before source code.
# This is a Docker best practice: if only source code changes
# (not dependencies), Docker reuses the cached npm install layer.
COPY backend/package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy the backend source code into the container
COPY backend/ .

# Copy the frontend so Express can serve it as static files
COPY frontend/ ../frontend/

# The port our Express server listens on (must match PORT in .env)
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
