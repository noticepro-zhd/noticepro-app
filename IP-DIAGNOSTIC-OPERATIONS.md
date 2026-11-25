# Header diagnostic operator notes

The temporary diagnostic is disabled unless `NOTICEPRO_IP_DIAGNOSTICS_ENABLED`
is exactly `true`. It is restricted in code to `zahidsapp.myshopify.com`, needs
an active UTC start/expiry window of at most 30 minutes, and allows six
requests per minute per app process. It does not resolve a country or make any
forwarded address trusted.

Optional private server settings:

- `NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV4`
- `NOTICEPRO_IP_DIAGNOSTICS_EXPECTED_IPV6`

Set either or both in the Render service's private environment. Values are
validated as public addresses before any comparison. If either configured
value is invalid, the expected-address configuration is invalid and no
addresses are compared. An IPv4-mapped IPv6 value can be entered in the IPv6
setting and will compare equivalently to its IPv4 form. The response exposes
only whether configuration is present/valid and a boolean match at each
forwarded-entry position; it never exposes an address or hash.

To find your public egress address, run these from the same test machine and
network path (including the same VPN/proxy choice) that will make the proxy
request:

```sh
curl --fail --silent --show-error --max-time 10 -4 https://api.ipify.org
printf '\n'
curl --fail --silent --show-error --max-time 10 -6 https://api64.ipify.org
printf '\n'
```

The output is for the operator's terminal only. Do not paste it into chat,
source files, tickets, or logs; enter it only in the private Render setting.
The lookup service receives the network request. IPv6 lookup can fail if that
network has no IPv6 egress. VPN, proxy, ISP, or network changes can change the
observed egress address; repeat the lookup privately and update the
corresponding setting before a new test window.

Even when a position matches, that is only an observation for this deployment
and test path. The diagnostic does not establish a platform guarantee or
enable production IP-country targeting.
