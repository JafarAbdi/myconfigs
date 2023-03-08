UID := $(shell id -u)

setup-fish:
	if [ "$(UID)" -eq 0 ]; then \
			echo "Installing packages without sudo..."; \
			apt install -y software-properties-common curl wget && apt-add-repository -y ppa:fish-shell/release-3; \
			apt install -y fish; \
	else \
			echo "Installing packages with sudo..."; \
			sudo apt install -y software-properties-common curl wget && sudo apt-add-repository -y ppa:fish-shell/release-3; \
			sudo apt install -y fish; \
	fi
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && config-fish'

core:
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && install-core'

host: core
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && setup-ssh-keys'
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && install-tmux unstable'
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && install-schroot && stow-schroot'
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && install-podman'
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && install-common-utils'
	fish -c 'source ~/myconfigs/fish/config.fish && stow-configs-host'
	sudo apt install fonts-jetbrains-mono
	# Required for the st's ligatures patch
	sudo apt install libharfbuzz-dev

dev: core
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && install-nvim stable'
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && install-mamba'
	fish -c 'source ~/myconfigs/fish/conf.d/installs.fish && install-full-development'