UID := $(shell id -u)

setup-fish:
	if [ "$(UID)" -eq 0 ]; then \
			echo "Installing packages without sudo..."; \
			apt update; \
			apt install -y software-properties-common curl wget && apt-add-repository -y ppa:fish-shell/release-3; \
			apt install -y fish; \
	else \
			echo "Installing packages with sudo..."; \
			sudo apt update; \
			sudo apt install -y software-properties-common curl wget && sudo apt-add-repository -y ppa:fish-shell/release-3; \
			sudo apt install -y fish; \
	fi
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && config-fish'

core:
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && install-core && stow-configs'

host: core
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && setup-ssh-keys'
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && install-tmux unstable'
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && install-podman'
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && install-common-utils'
	sudo apt install fonts-jetbrains-mono

dev-core:
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && install-dev-core && install-nvim stable'

dev-lua:
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && install-lua-lsp && install-luacheck'

dev-python:
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && install-mamba && install-efm-lsp'

dev-rust:
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && install-rust-lsp'

dev-cpp:
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && install-cpp-lsp && install-cpp-analyzers'

dev: core dev-core dev-lua dev-python dev-rust dev-cpp
