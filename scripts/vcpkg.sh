#!/bin/bash -eu

setup_vcpkg()
{
	if [[ -d $WORKSPACE_DIR/vcpkg ]]; then
		export VCPKG_DIR=$WORKSPACE_DIR/vcpkg
		source $VCPKG_DIR/scripts/vcpkg_completion.bash
		alias cdvcpkg="cd $VCPKG_DIR"
		export CMAKE_TOOLCHAIN_FILE=$VCPKG_DIR/scripts/buildsystems/vcpkg.cmake
		local cmake_version="$(cmake --version | grep "cmake version" | awk '{print $3}')"
		if dpkg --compare-versions "$cmake_version" ge 3.21; then
			console_red
			echo "cmake version is larger than 3.21 no need to alias cmake with CMAKE_TOOLCHAIN_FILE see https://cmake.org/cmake/help/latest/envvar/CMAKE_TOOLCHAIN_FILE.html#envvar:CMAKE_TOOLCHAIN_FILE"
			console_nored
		fi
		alias cmake_vcpkg="cmake -DCMAKE_TOOLCHAIN_FILE=$CMAKE_TOOLCHAIN_FILE"
	fi
}

setup_vcpkg
