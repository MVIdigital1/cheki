/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["playwright-core", "@sparticuz/chromium"],
  },
  webpack: (config) => {
    config.externals.push(
      "chromium-bidi/lib/cjs/bidiMapper/BidiMapper",
      "chromium-bidi/lib/cjs/cdp/CdpConnection",
      "kerberos"
    );
    return config;
  },
};

module.exports = nextConfig;
