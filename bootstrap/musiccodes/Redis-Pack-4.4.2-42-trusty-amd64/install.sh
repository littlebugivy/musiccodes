#!/bin/bash
PKG_FILES=" redislabs_4.4.2-42~trusty_amd64.deb redislabs-utils_4.4.2-42~trusty_amd64.deb"  # A list of all bundled packages
DOC_TAR_FILE="rlec_rest_api.tar.gz"
PATH=$PATH:/opt/redislabs/bin/
SUPPORTED_REDIS_VERSIONS="3.0 3.0-big 3.2 3.2-big"
TMP_PATH="/tmp"
LOG_PATH="/var/opt/redislabs/log"
VER_PATH="/etc/opt/redislabs"
LOG_FILE="install.log"
VER_FILE="versions.json"
DOCS_DIR="/usr/share/doc/redislabs"
MIN_ENDPOINTS_PORT_RANGE=10000  # Used for exposing databases externally (10000-19999)
MAX_SHARDS_PORT_RANGE=29999    # Used for internal communications with database shards (20000-29999)
REQUIRED_PORTS="3333 3334 3335 3336 3337 36379 36380 53 8443 8080 9443" # See the user man. for a list of ports used by RLEC.

COMPATIBLE_VERSIONS="4.3.0 4.3.2 4.4.0 4.4.1 4.4.2 100.0.0 100.1.0"


if [ ! -n "$INSTALL_FLAG" ]; then
        sudo_cmd=${sudocmd:-sudo}
        if [ `whoami` = root ]; then
            sudo_cmd=""
        fi
	export INSTALL_FLAG="true"
	mkdir -p $TMP_PATH && touch $TMP_PATH/$LOG_FILE
	echo '{ "compatible_versions": [ "'${COMPATIBLE_VERSIONS}'" ] }' > $TMP_PATH/$VER_FILE
	$0 $* 2>&1 | tee $TMP_PATH/$LOG_FILE
	OUT=$?
	${sudo_cmd} mv $TMP_PATH/$LOG_FILE $LOG_PATH/$LOG_FILE
	${sudo_cmd} mv $TMP_PATH/$VER_FILE $VER_PATH/$VER_FILE
	exit $OUT	
fi

print() {
    local msgtype="$1"
    local message="$2"
    local opt="$3"
    local date="$(date +'%Y-%m-%d %H:%M:%S') "
    local prefix

    case $msgtype in
        progress)
            prefix="${c_lgreen}[.] "
            ;;
        info)
            prefix="${c_yellow}[!] "
            ;;
        error)
            prefix="${c_red}[x] "
            ;;
        warning)
            prefix="${c_red}[!] "
            ;;
        confirm)
            prefix="${c_lblue}[?] "
            ;;
        exec)
            prefix="${c_lgrey}[$] executing: "
            ;;
        *)
            prefix="    "
            ;;
    esac

    echo -e $opt "${date}${prefix}${message}${c_normal}"
}

leash_off() {
    print info "Calling leash.py off"
    if [ -f rlec_upgrade_tmpdir/leash.py ]; then
        python2.7 -O rlec_upgrade_tmpdir/leash.py off
    else
        python2.7 -O /opt/redislabs/sbin/leash.py off
    fi
}

abort() {
    local message="$1"
    print error "$message"
    exit 1
}

execute() {
    print exec "'$*'"
    echo -e -n "${c_grey}"
    $sudo_cmd "$@"
    local ret=$?
    echo -e -n "${c_normal}"
    return $ret
}

confirm() {
    local message="$1"
    local configvar="$2"
    local response

    config_variable="CONFIG_${configvar}"
    if [ "${!config_variable}" = "yes" ]; then
        return 0
    elif [ "${!config_variable}" = "no" ]; then
        return 1
    fi

    if [ "$YES_TO_ALL" = 1 ]; then
        return 0
    fi

    while true; do
        print confirm "$message [Y/N]? " -n

        read response
        case "$response" in
            y|Y) 
                return 0;
                ;;
            n|N)
                return 1;
                ;;
            *)
                print confirm "Please respond with [Y] or [N]."
                ;;
        esac
    done
}

local_addr() {
    if [ -x /usr/sbin/ip ]; then
        /usr/sbin/ip addr | awk '/^ *link\// { encap=$1 } /^ *inet / { if (encap=="link/ether") print $2 }' | head -1 | sed 's#/.*$##'
    else
        /sbin/ifconfig | awk '/^[^ ]/ { encap=$3 } /^ *inet addr/ { if (encap=="encap:Ethernet") print $2} '|head -1|sed 's/.*://'
    fi
}

setup_terminal() {
    if [ "$TERM" = "xterm" -o "$TERM" = "linux" -o "$TERM" = "xterm-256color" ]; then
        c_bold="\e[1m"
        c_unbold="\e[21m"
        c_red="\e[91m"
        c_grey="\e[90m"
        c_lgrey="\e[37m"
        c_yellow="\e[33m"
        c_lgreen="\e[92m"
        c_lblue="\e[94m"
        c_normal="\e[0m"
    fi

    redislabs="${c_bold}${c_red}redis${c_grey}labs${c_normal}"
    RedisLabs="${c_bold}${c_red}Redis${c_grey}Labs${c_normal}"
}

read_depends() {
    local dpkg="$1"
    local all_depends=`dpkg --info $1 | sed -n 's/ *Depends: *// p' | sed 's/([^)]*)//g' | sed 's/[,|]//g'`
    for dep in $all_depends; do
        case $dep in
            libgcc1|libc6|sysv-rc|file-rc)
                ;;
            *)
                dpkg_depends="$dpkg_depends $dep"
                ;;
        esac
    done
}

setup_terminal
while [ $# -gt 0 ]; do
    if [ "$1" = "-y" ]; then
        YES_TO_ALL=1
    elif [ "$1" = "-i" ]; then
        IGNORE_WARNINGS=1
    elif [ "$1" = "-c" ]; then
        if [ $# -lt 2 ]; then
            echo "Error: no config file specified."
            exit 1
        fi
        shift
        eval $(cat $1 | sed 's/^/export CONFIG_/') || echo "Error: failed to read $1"
    else
        echo "Error: invalid argument: $1"
        exit 1
    fi
    shift
done

echo -e "================================================================================"
echo -e "${RedisLabs} Enterprise Cluster installer."
echo -e "================================================================================"
echo ""

print progress "Checking root access"
if [ `whoami` = root ]; then
    print info "Running as user root, sudo is not required."
    sudo_cmd=""
else
    print progress "Not root, checking sudo"
    if [ `sudo whoami` != root ]; then
        abort "Failed to use sudo, please check configuration"
    else
        print info "sudo is working, you may need to re-type your password"
        sudo_cmd="sudo "
    fi
fi

print progress "Checking prerequisites"
if [ -f /etc/redhat-release ]; then
    disttype=redhat
    arch=`uname -p`
    pkgext=rpm
elif grep -q '^ID_LIKE=.*rhel' /etc/os-release; then
    disttype=redhat
    arch=`uname -p`
    pkgext=rpm
else
    case `lsb_release -cs` in
        trusty|utopic|vivid|wily|xenial)
            ;;
        *)
            abort "Unsupported Linux distribution."
            ;;
    esac

    disttype=debian
    arch=`dpkg --print-architecture`
    pkgext=deb
fi

# Check hardware architecture packages
arch_supported=0
for file in ${PKG_FILES}; do
    if [[ "$file" =~ $arch\.$pkgext ]]; then
        arch_supported=1
    fi
done
if [ "$arch_supported" = 0 ]; then
    abort "Unsupported hardware architecture."
fi

if [ ! -d "/opt/redislabs/" ]; then

# Check that no one uses port 53
    UDP_USED_SERVICE=`netstat -lputn | awk '/:53 .*/ { num = split($NF, a, "/"); seen[$NF]++; if (seen[$NF] < 2) { print a[num] ;} ;}'`

    if [ -n "${UDP_USED_SERVICE}" ]; then
        print error "You have an installation of ${UDP_USED_SERVICE} (DNS server/s) installed, please remove it and run installation again."
        abort "Another DNS server already installed."
    fi

fi

# Read dependencies
if [ "$disttype" = "debian" ]; then
    dpkg_depends=""
    for file in ${PKG_FILES}; do
        if [ ! -f ${file} ]; then
            print error "Missing installation file: ${file}"
            abort "Make sure you run the script from the local installation directory."
        fi
        read_depends ${file}
    done

    missing_depends=""
    print progress "Verifying that all required packages are installed"
    for dep in $dpkg_depends; do
        if ! echo ${PKG_FILES} | grep -Pq "\b$dep\b"; then
            if ! dpkg -s $dep | grep -q '^Status:.* installed' >/dev/null 2>&1; then
                print info "${c_bold}${dep}${c_unbold}: package is not installed, will attempt auto-install"
                missing_depends="${missing_depends} ${dep}"
            fi
        fi
    done

    if [ -n "${missing_depends}" ]; then
        print progress "Attempting to install missing dependencies"
        execute apt-get update && execute apt-get install -y ${missing_depends}
        if [ $? != 0 ]; then
            print error "Failed to automatically install dependencies, please do that manually and retry."
            exit 1
        fi
    fi
fi

if [ "$disttype" == "debian" ]; then
    redislabs_installed="dpkg --get-selections | cut -f1 | grep -Fxq redislabs"
else
    redislabs_installed="rpm -aq | grep -q redislabs"
fi
if eval $redislabs_installed; then

    # By default when Upgrade phase begins all nodes have same cnm version
    upgrade_starting=True

    # Checking upgrade prerequisites
    if [ -f "/etc/opt/redislabs/ccs-auth.conf" ]; then
        pass="`awk '/^requirepass / { print $2 }' /etc/opt/redislabs/ccs-auth.conf`"
        if [ -z "$pass" ]; then
            print error "Failed reading CCS authentication file."
            exit 1
        fi
        replication_state=`/opt/redislabs/bin/redis-cli -s /tmp/local_ccs.sock -a $pass info replication`
        counter=0
        if [[ "$replication_state" != *"role:master"* ]]; then
            while [[ "$replication_state" != *"master_link_status:up"* ]]; do
                if [ $counter -ge 10 ]; then
                    print error "Failed to sync with master ccs"
                    exit 1
                fi
                print progress "Waiting for node to synchronize with cluster"
                sleep 10
                replication_state=`/opt/redislabs/bin/redis-cli -s /tmp/local_ccs.sock -a $pass info replication`
                ((counter++))
            done
        fi
    fi

    # Verify we can upgrade from current to future version
    PKGS=($PKG_FILES)
    if [ "$disttype" = "debian" ]; then
        # Both return version including build number 1.0.0-1, but we need the curr version without it for the matching
        new_version=$(dpkg-deb --showformat='${Version}' -W ${PKGS[0]})
        curr_version=$(dpkg-query --showformat='${Version}' -W redislabs | cut -d "-" -f1)
    else
        # Both returns version without build number 1.0.0
        new_version=$(rpm -qp --queryformat '%{VERSION}' ${PKGS[0]})
        curr_version=$(rpm -q --queryformat '%{VERSION}' redislabs)
    fi
    if ! [[ "$COMPATIBLE_VERSIONS" =~ $curr_version ]]; then
        abort "Upgrade aborted. Upgrading to version $new_version is only allowed from versions: $COMPATIBLE_VERSIONS. You are currently upgrading from version $curr_version.";
    fi

	# Getting the node id
	node_id=$($sudo_cmd cat /etc/opt/redislabs/node.id 2>/dev/null)
	if [ -z "${node_id}" ]; then
       if ! confirm "Cannot validate current node status. Do you want to continue the upgrade"; then
           abort "Upgrade aborted."
       fi
    fi

    if [ -n "$node_id" ]; then
        # Verifying the node is active
        node_status="$($sudo_cmd /opt/redislabs/bin/ccs-cli hget node:$node_id status 2>/dev/null)"
        if [ $? != 0 -o "$node_status" != "active" ]; then
            abort "The node is currently offline or removed. Upgrade has been aborted. Please ensure the node is online and try running the upgrade again."
        fi

        # Verifying all shards are running a supported redis version
        for bdb_id in $($sudo_cmd /opt/redislabs/bin/ccs-cli smembers bdb:all | cut -d " " -f2); do
            redis_version=$($sudo_cmd /opt/redislabs/bin/ccs-cli hget bdb:$bdb_id redis_version);
            if ! [[ $SUPPORTED_REDIS_VERSIONS =~ $redis_version ]]; then
                abort "Upgrade aborted. Prior to upgrading RLEC all databases must be upgraded to the latest supported version of redis."
            fi

            # Verifying no 'RUNNING' state machines
            if [ -z $IGNORE_WARNINGS ]; then
                cnm_exec_sm=$($sudo_cmd /opt/redislabs/bin/ccs-cli hget bdb:$bdb_id cnm_exec_sm)
                if [ $cnm_exec_sm ]; then
                    cnm_exec_state=$($sudo_cmd /opt/redislabs/bin/ccs-cli hget bdb:$bdb_id cnm_exec_state)
                    if [ "$cnm_exec_state" != "done" -a "$cnm_exec_state" != "error" ]; then
                        abort "Background processes currently running are preventing successful upgrade. Upgrade has been aborted. Please try running the upgrade again."
                    fi
                fi
            fi
        done

        # Checking if we are in the beginning of an upgrade
        previous_node_version=none
        # Get the List of Node Ids from the ccs-cli command using the cut with " " delimeter...
        for tmp_node_id in $($sudo_cmd /opt/redislabs/bin/ccs-cli smembers node:all | cut -d " " -f2); do
            cnm_version=$($sudo_cmd /opt/redislabs/bin/ccs-cli hget node:$tmp_node_id cnm_version);
            if [ "previous_node_version" == "none" ]; then
                previous_node_version=$cnm_version
            elif [ "$previous_node_version" != "$cnm_version" ]; then
                upgrade_starting=False
                break
            fi
        done

        #Verifing that all databases are with the same version, in case we are starting the upgrade
        if [[ $($sudo_cmd /opt/redislabs/bin/rladmin status) =~ "OLD VERSION" && -z "$IGNORE_WARNINGS" && "$upgrade_starting" != "False" ]]; then
            abort "Upgrade aborted. Prior to upgrading RLEC all databases must be upgraded to the latest redis version supported."
        fi

        # Verifying no shard is syncing
        for shard_id in $($sudo_cmd /opt/redislabs/bin/ccs-cli smembers redis:all | cut -d " " -f2); do
            master_link_status="$($sudo_cmd /opt/redislabs/bin/shard-cli $shard_id info replication | grep master_link_status | cut -d ":" -f2 | tr -d '\r')"
            if [ -n "$master_link_status" -a "$master_link_status" != "up" ]; then
               bdb_id="$($sudo_cmd /opt/redislabs/bin/ccs-cli hget redis:$shard_id bdb_uid)"
               if ! confirm "shard:$shard_id of db:$bdb_id is now syncing. Do you want to continue the upgrade"; then
                   abort "Upgrade aborted."
               fi
            fi
        done

        # Verifying no tasks are running on node upgrade
        if [ -z $IGNORE_WARNINGS ]; then
            status=$(/opt/redislabs/bin/rladmin cluster running_actions)
            if [[ ! "$status" =~ "No active tasks" ]]; then
                if [[ ! "$status" =~ "ERROR: invalid token 'running_actions'" ]]; then
                  # when we upgrading to a version that doesn't contain the running_actions command we want to skip this check
                  abort "Background processes currently running are preventing successful upgrade. Upgrade has been aborted. Please try running the upgrade again."
                fi
            fi
        fi

        # run leash.py script before starting upgrade
        python2.7 -O rlec_upgrade_tmpdir/leash.py on
        retval=$?
        if [ $retval -ne 0 ]; then
            print warning "leash.py returned an error. see $LOG_PATH/$LOG_FILE for details."
        else
            trap leash_off EXIT
        fi
    fi
else
    # Verifying required ports are free
    occupied_ports=$(netstat -lntu | tail -n +3 | awk '{print $4}' | grep -o '[^:]*$')
    for occupied_port in ${occupied_ports[@]}; do
        if [[ $REQUIRED_PORTS =~ $occupied_port ||
              ( $occupied_port -ge $MIN_ENDPOINTS_PORT_RANGE && $occupied_port -le $MAX_SHARDS_PORT_RANGE ) ]]; then
            print error "Port $occupied_port is occupied."
        fi
    done
fi

# Checking if swap is enabled
if [[ $(wc -l < /proc/swaps) -gt 1 ]]; then
    if ! confirm "Swap is enabled. Do you want to proceed?"; then
        abort "Process aborted."
    fi
fi

print progress "Installing ${RedisLabs} packages"
if [ "$disttype" = "debian" ]; then
    execute dpkg -i ${PKG_FILES} || abort "dpkg -i failed"
else
    # For yum we need to know what to install, reinstall or upgrade
    for pkg in ${PKG_FILES}; do
        pkg_basename=`echo $pkg|sed 's/-[0-9].*$//'`
        installed="`rpm -q ${pkg_basename}`"
        if [ "${installed}.rpm" = $pkg ]; then
            reinstall_list="${reinstall_list} $pkg"
        elif [[ "${installed}" =~ "not installed" ]]; then
            install_list="${install_list} $pkg"
        else
            upgrade_list="${upgrade_list} $pkg"
        fi
    done
    if [ -n "${upgrade_list}" ]; then
        execute yum upgrade -y ${upgrade_list} || abort "yum upgrade failed"
    fi
    if [ -n "${install_list}" ]; then
        execute yum install -y ${install_list} || abort "yum install failed"
    fi
    if [ -n "${reinstall_list}" ]; then
        execute yum reinstall -y ${reinstall_list} || abort "yum reinstall failed"
    fi
fi

if confirm "Do you want to automatically tune the system for best performance" "systune"; then
    print progress "Tuning core configuration if necessary."
    execute /opt/redislabs/sbin/config_cores
    if [ $? = 0 ]; then
        # re-load proxy with new cores settings
        execute service dmcproxy restart
    fi
    print progress "Running systune.sh and setting up rc.local to re-run it on reboot."
    execute /opt/redislabs/sbin/systune.sh || print warning "System tuning failed."
    (
        if [ -f /etc/rc.d/rc.local ]; then
            rcscript=/etc/rc.d/rc.local
        else
            rcscript=/etc/rc.local
        fi

        set -e
        execute sed -i '/redislabs/ d' ${rcscript}
        if grep -q '^exit' ${rcscript}; then
            execute sed -i '/^exit/ i/opt/redislabs/sbin/systune.sh' ${rcscript}
        else
            execute sed -i '$ i/opt/redislabs/sbin/systune.sh' ${rcscript}
        fi
        if [ ! -x ${rcscript} ]; then
            chmod a+x ${rcscript}
        fi
        set +e
    ) || print warning "Failed to update rc.local"
fi

if confirm "Cluster nodes must have their system time synchronized.\nDo you want to set up NTP time synchronization now" "ntp"; then
    print progress "Making sure NTP is installed and time is set."
    (
    set -e
    if [ "$disttype" = "debian" ]; then
        execute apt-get install -y ntpdate ntp || print warning "Failed to install NTP packages."
        execute ntpdate-debian -u || print warning "Failed to synchronize system time with NTP service."
    else
        # Check if we install, reinstall or upgrade
        yum list installed chrony > /dev/null 2>&1
        yum_result=$?
        if [[ $yum_result != 0 ]]; then
            execute yum install -y ntp || print warning "Failed to install NTP package."
            execute ntpdate -u pool.ntp.org || print warning "Failed to update system time."
            if [ -x /usr/bin/systemctl ]; then
                execute systemctl enable ntpd.service || print warning "Failed to enable NTP service."
                execute systemctl start ntpd.service || print warning "Failed to start NTP service."
            else
                execute /sbin/chkconfig ntpd on || print warning "Failed to enable NTP service."
                execute /etc/init.d/ntpd start || print warning "Failed to start NTP service."
            fi
        else
            print info "Chrony service is already installed, skipping NTP installation."
            execute systemctl enable chronyd.service || print warning "Failed to enable Chrony service."
            execute systemctl start chronyd.service || print warning "Failed to start Chrony service."
            execute chronyc -a makestep || print warning "Failed to update system time."
        fi
    fi
    set +e
    ) || print warning "Error encountered while trying to configure NTP. You should configure a cron job to regularly sync with NTP to ensure proper cluster operation."
else
    print warning "NOT auto-configuring NTP, please manually synchronize cluster node clocks."
fi

if [ -x /bin/firewall-cmd ]; then
    firewall=firewalld
elif [ -x /usr/sbin/lokkit ]; then
    firewall=system-config-firewall
    # Make sure lokki does not start iptables if it's not loaded
    /sbin/iptables -L --line-numbers | grep -q '^[0-9]'
    if [ $? != 0 ]; then
        lokkit_args="--nostart"
    fi
fi

if [ -n "$firewall" ]; then
    if confirm "This machine seems to have a firewall installed.\nWould you like to open RedisLabs cluster ports on the default firewall zone" "firewall"; then
        if [ "$firewall" = "firewalld" ]; then
            execute /bin/firewall-cmd --add-service=redislabs
            execute /bin/firewall-cmd --add-service=redislabs --permanent
        elif [ "$firewall" = "system-config-firewall" ]; then
            execute /usr/sbin/lokkit ${lokkit_args} \
                --port=3333-3337:tcp \
                --port=8080:tcp \
                --port=8443:tcp \
                --port=5353:udp \
                --port=53:udp \
                --port=10000-19999:tcp \
                --port=20000-29999:tcp \
                --port=36379:tcp
        fi
    fi
fi

# Print warning message if logs are kept on the root file system (and it is below 128GB)
log_mount_point=`stat --format=%m $LOG_PATH/.`
if [ "${log_mount_point}" = "/" ]; then
    root_size=`stat --format '%S %b' -f / | awk '{print sprintf("%.0f" ,$1 * $2) }'`
    WARNING_THRESHOLD=$((128*1024*1024*1024))
    if [ "$root_size" -lt "$WARNING_THRESHOLD" ] ; then
        print warning "Note: Log files will be stored on the root file system, in path $LOG_PATH"
    fi
fi

# install the documents package
if [ -f "${DOC_TAR_FILE}" ]; then	
	if [ ! -d "${DOCS_DIR}" ] ; then
		${sudo_cmd} mkdir -p ${DOCS_DIR}
	fi
        ${sudo_cmd} cp "${DOC_TAR_FILE}" "${DOCS_DIR}"
	echo ""
	echo -e "${RedisLabs} rest-api documentation has been deployed in ${DOCS_DIR} ."	
	echo ""
elif [ -n "${DOC_TAR_FILE}" ]; then
    print warning "Missing documentation tar file: ${DOC_TAR_FILE}"
else
	print warning "Missing documentation tar file."
fi

# Removing the upgrade folder now that install is finished
rm -fr rlec_upgrade_tmpdir

# warm the log files for rladmin/rlutil on upgrade/install as root. this will create the log files with the appropriate permissions.
/opt/redislabs/bin/rladmin help > /dev/null 2>&1 || /bin/true
/opt/redislabs/bin/rlutil help > /dev/null 2>&1 || /bin/true

print info "Installation is complete!"

if confirm "Would you like to run rlcheck to verify proper configuration?" "rlcheck"; then
    execute /opt/redislabs/bin/rlcheck --suppress-tests=verify_bootstrap_status,verify_processes || exit 1 
fi

print info "Please logout and login again to make sure all environment changes are applied."
print info "Point your browser at the following URL to continue:"
print info "${c_bold}https://`local_addr`:8443"
