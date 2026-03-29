# Running MicroRealEstate with Finch (Docker Alternative)

This guide covers setting up MicroRealEstate using [Finch](https://github.com/runfinch/finch) instead of Docker Desktop. This is useful when Docker Desktop requires org sign-in or licensing that blocks usage.

## Prerequisites

- macOS (Apple Silicon or Intel)
- [Homebrew](https://brew.sh/) installed

## 1. Install Finch

```shell
brew install --cask finch
```

The Finch binary installs to `/Applications/Finch/bin/finch`.

### Apple Silicon Macs (M1/M2/M3/M4)

If your Homebrew runs under Rosetta (installed at `/usr/local` instead of `/opt/homebrew`), it may install the x86 version. If you see errors like `limactl is running under rosetta`, install the ARM version manually:

```shell
curl -L -o /tmp/finch-arm64.pkg "https://github.com/runfinch/finch/releases/download/v1.15.1/Finch-v1.15.1-aarch64.pkg"
sudo installer -pkg /tmp/finch-arm64.pkg -target /
```

Check your architecture with `uname -m` — if it says `arm64`, you need the aarch64 package.

## 2. Initialize and Start the Finch VM

```shell
/Applications/Finch/bin/finch vm init
```

This downloads a Linux VM image and sets up the container runtime. It requires sudo for network configuration and takes a few minutes on first run.

If the VM was partially created (e.g. due to a network timeout), start it with:

```shell
/Applications/Finch/bin/finch vm start
```

Verify it's running:

```shell
/Applications/Finch/bin/finch --version
```

## 3. Configure the Environment

Copy the env template and generate secrets:

```shell
cp .env.domain .env
```

Replace the placeholder secrets at the bottom of `.env` with random values:

```shell
# Generate a random secret
openssl rand -base64 12
```

Update these keys in `.env` with unique generated values:
- `ACCESS_TOKEN_SECRET`
- `REFRESH_TOKEN_SECRET`
- `RESET_TOKEN_SECRET`
- `APPCREDZ_TOKEN_SECRET`
- `CIPHER_IV_KEY`
- `CIPHER_KEY`
- `REDIS_PASSWORD`

The email configuration (`GMAIL_EMAIL`, `SMTP_*`, etc.) can be left as defaults for local testing — email features just won't work.

## 4. Start the Application

```shell
APP_PORT=8080 /Applications/Finch/bin/finch compose --profile local up
```

The first run pulls all container images (MongoDB, Redis, app services) which can take several minutes depending on your connection.

Once you see `Gateway ready and listening on port 8080`, the app is available at:
- Landlord UI: http://localhost:8080/landlord
- Tenant UI: http://localhost:8080/tenant

## 5. Stop the Application

Press `Ctrl+C` in the terminal running compose, or from another terminal:

```shell
/Applications/Finch/bin/finch compose --profile local down
```

This stops the app containers but keeps the Finch VM running, so you can quickly `compose up` again.

To also shut down the Finch VM (frees up system resources, but requires `finch vm start` before you can run containers again):

```shell
/Applications/Finch/bin/finch vm stop
```

## Optional: Add Finch to PATH

To avoid typing the full path every time:

```shell
echo 'export PATH="/Applications/Finch/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Then you can use `finch` directly:

```shell
finch compose --profile local up
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `limactl is running under rosetta` | Install the ARM64 `.pkg` manually (see step 1) |
| `failed to download` during `vm init` | Network timeout — run `finch vm start` to retry |
| `instance already exists but is stopped` | Run `finch vm start` instead of `finch vm init` |
| Containers can't pull images | Check your network/VPN; retry usually works |
