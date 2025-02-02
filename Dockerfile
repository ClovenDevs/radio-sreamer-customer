# Use Node.js as base image
FROM node:20-bullseye-slim

# Install FFmpeg and other dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Install bun
RUN curl -fsSL https://bun.sh/install | bash

# Copy package files
COPY package.json ./
COPY bun.lock ./
COPY tsconfig.json ./

# Install dependencies
RUN /root/.bun/bin/bun install

# Copy the rest of the application
COPY . .

# Create necessary directories
RUN mkdir -p uploads assets

# Build TypeScript
RUN /root/.bun/bin/bun build ./index.ts --outdir ./out

# Environment variables
ENV NODE_ENV=production
ENV FFMPEG_PATH=/usr/bin/ffmpeg

# Expose the port the app runs on
EXPOSE 3000

# Command to run the application
CMD ["node", "out/index.js"]