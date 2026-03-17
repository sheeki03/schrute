class Schrute < Formula
  desc "Self-learning browser agent — record once, replay 100x faster via MCP"
  homepage "https://github.com/sheeki03/schrute"
  url "https://registry.npmjs.org/schrute/-/schrute-0.1.0.tgz"
  sha256 "" # Fill after npm publish: shasum -a 256 schrute-0.1.0.tgz
  license "Apache-2.0"

  depends_on "node@22"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir[libexec/"bin/*"]
  end

  def post_install
    # Install Playwright Chromium so `schrute explore` works out of the box
    system libexec/"bin/schrute", "setup"
  end

  def caveats
    <<~EOS
      Schrute has been installed with Playwright Chromium.

      Quick start:
        schrute explore https://example.com   # Open browser session
        schrute record --name my-action       # Record an action
        schrute stop                          # Generate skills
        schrute skills list                   # See learned skills

      Use as MCP server (Claude Code, Cursor, etc.):
        schrute serve

      Run diagnostics:
        schrute doctor
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/schrute --version")
    # Doctor check (may warn about keychain in CI but should not crash)
    output = shell_output("#{bin}/schrute doctor --json 2>&1", 0)
    assert_match "browser_engine", output
  end
end
