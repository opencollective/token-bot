# Use the official Deno image
FROM denoland/deno:alpine-2.5.4

# Install curl and git (git for status.json endpoint)
RUN apk add --no-cache curl git

# Create app directory
RUN mkdir -p /app

# Set working directory
WORKDIR /app

# Copy your project files (includes pre-compiled hardhat/artifacts)
COPY . .

# API server port
EXPOSE 3000

CMD ["deno", "task", "start"]
