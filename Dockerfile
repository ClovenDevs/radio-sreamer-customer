# Use Node.js as base image
FROM node:20-bullseye-slim

# Install FFmpeg and other dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Install bun
RUN curl -fsSL https://bun.sh/install | bash

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN /root/.bun/bin/bun install

# Copy the rest of the application
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Command to run the application
CMD ["/root/.bun/bin/bun", "run", "index.ts"]
