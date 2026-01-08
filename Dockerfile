# Use Node.js 18
FROM node:18-bullseye

# Install Java, wget, unzip, zip, 32-bit libraries (required by Android tools)
RUN dpkg --add-architecture i386 \
 && apt update \
 && apt install -y openjdk-17-jdk wget unzip zip lib32stdc++6 lib32z1 curl git && rm -rf /var/lib/apt/lists/*

# Set Android SDK root
ENV ANDROID_SDK_ROOT=/opt/android-sdk
RUN mkdir -p $ANDROID_SDK_ROOT/cmdline-tools

# Download Android command-line tools
RUN wget https://dl.google.com/android/repository/commandlinetools-linux-9477386_latest.zip -O /tmp/cmdline-tools.zip \
 && unzip /tmp/cmdline-tools.zip -d /tmp/cmdline-tools \
 && mkdir -p $ANDROID_SDK_ROOT/cmdline-tools/latest \
 && mv /tmp/cmdline-tools/cmdline-tools/* $ANDROID_SDK_ROOT/cmdline-tools/latest/

# Set PATH to include SDK tools
ENV PATH=$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/build-tools/34.0.0

# Accept licenses and install build-tools
RUN yes | sdkmanager --licenses
RUN sdkmanager "build-tools;34.0.0"

# Working directory
WORKDIR /app

# Copy project files
COPY . .

# Install Node.js dependencies
RUN npm install

# Create necessary directories
RUN mkdir -p uploads uploads_tmp output keys \
 && chmod -R 777 uploads uploads_tmp output keys

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
