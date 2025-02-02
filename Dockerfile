# Use Node.js as base image
FROM node:20-bullseye-slim

# Install FFmpeg and other dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the built application and assets
COPY out ./out
COPY assets ./assets
COPY views ./views

# Create uploads directory and ensure proper permissions
RUN mkdir -p uploads && \
    chown -R node:node /app

# Switch to non-root user
USER node

# Expose the port the app runs on
EXPOSE 3000

# Command to run the application
CMD ["npm", "start"]