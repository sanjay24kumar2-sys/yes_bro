FROM node:18-bullseye

# Install Java & tools
RUN apt update && apt install -y openjdk-17-jdk wget unzip zip curl git lib32stdc++6 lib32z1 && rm -rf /var/lib/apt/lists/*

# Android SDK
ENV ANDROID_SDK_ROOT=/opt/android-sdk
RUN mkdir -p $ANDROID_SDK_ROOT/cmdline-tools

# Download command-line tools
RUN wget https://dl.google.com/android/repository/commandlinetools-linux-9477386_latest.zip -O /tmp/cmdline-tools.zip \
 && unzip /tmp/cmdline-tools.zip -d /tmp/cmdline-tools \
 && mkdir -p $ANDROID_SDK_ROOT/cmdline-tools/latest \
 && mv /tmp/cmdline-tools/cmdline-tools/* $ANDROID_SDK_ROOT/cmdline-tools/latest/

# Add SDK tools to PATH
ENV PATH=$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools

# Accept licenses & install build-tools
RUN yes | sdkmanager --licenses
RUN sdkmanager "platform-tools" "build-tools;34.0.0" || true

# Working directory
WORKDIR /app

# Copy project
COPY . .

# Install Node.js dependencies
RUN npm install

# Create required directories
RUN mkdir -p uploads uploads_tmp output keys && chmod -R 777 uploads uploads_tmp output keys

# Expose port (Railway uses process.env.PORT)
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
