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

## Reclaiming disk space

The Finch VM uses a 50 GB **raw** disk image at `~/.finch/.disks/<id>`. As you pull and rebuild images, the file accumulates layer data and the macOS-side file size creeps toward 50 GB even after you delete containers and images.

**This is expected behavior.** The raw format doesn't auto-trim, so unused blocks stay allocated until you explicitly trim them.

### Quick cleanup (recommended monthly or after big rebuilds)

```shell
# Stop everything first
finch compose -f docker-compose.microservices.base.yml -f docker-compose.microservices.dev.yml down

# Remove unused images, stopped containers, and build cache
finch system prune -a -f

# Remove unused volumes (system prune doesn't touch these)
finch volume prune -a -f

# Tell macOS to reclaim the freed blocks
export LIMA_HOME=/Applications/Finch/lima/data
/Applications/Finch/lima/bin/limactl shell finch sudo fstrim -v /mnt/lima-finch
```

The `fstrim` command is the one that actually shrinks the file on macOS. Without it, prune frees space inside the VM but the host file stays the same size.

### Verify space was reclaimed

```shell
du -sh ~/.finch/.disks/
```

You should see the size drop dramatically. After a full cleanup with no images cached, expect ~1 GB. After re-pulling the MRE images for dev, expect ~15 GB.

### Notes

- `finch vm disk resize` only goes UP, not down. The 50 GB cap is the maximum the VM will ever use; trimming brings actual on-disk usage back close to what's really stored.
- `finch vm remove && finch vm init` wipes the VM but creates a new 50 GB raw file — same problem. Trimming is the correct approach.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `limactl is running under rosetta` | Install the ARM64 `.pkg` manually (see step 1) |
| `failed to download` during `vm init` | Network timeout — run `finch vm start` to retry |
| `instance already exists but is stopped` | Run `finch vm start` instead of `finch vm init` |
| Containers can't pull images | Check your network/VPN; retry usually works |
| `~/.finch` is using tens of gigabytes on disk | Run the cleanup steps in [Reclaiming disk space](#reclaiming-disk-space). The raw VM disk format doesn't auto-trim. |
