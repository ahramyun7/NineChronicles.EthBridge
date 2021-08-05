import Web3 from "web3";
import { init } from "@sentry/node";
import { KmsProvider } from "aws-kms-provider";

import { IWrappedNCGMinter } from "./interfaces/wrapped-ncg-minter";
import { INCGTransfer } from "./interfaces/ncg-transfer";
import { EthereumBurnEventMonitor } from "./monitors/ethereum-burn-event-monitor";
import { NineChroniclesTransferredEventMonitor } from "./monitors/nine-chronicles-transferred-event-monitor";
import { NCGTransfer } from "./ncg-transfer";
import { WrappedNCGMinter } from "./wrapped-ncg-minter";
import { wNCGTokenAbi } from "./wrapped-ncg-token";
import { HeadlessGraphQLClient } from "./headless-graphql-client";
import { IHeadlessHTTPClient } from "./interfaces/headless-http-client";
import { HeadlessHTTPClient } from "./headless-http-client";
import { ContractDescription } from "./types/contract-description";
import { IMonitorStateStore } from "./interfaces/monitor-state-store";
import { Sqlite3MonitorStateStore } from "./sqlite3-monitor-state-store";
import { WebClient } from "@slack/web-api"
import { URL } from "url";
import { Configuration } from "./configuration";
import { NCGTransferredEventObserver } from "./observers/nine-chronicles"
import { EthereumBurnEventObserver } from "./observers/burn-event-observer"

(async () => {
    const GRAPHQL_API_ENDPOINT: string = Configuration.get("GRAPHQL_API_ENDPOINT");
    const HTTP_ROOT_API_ENDPOINT: string = Configuration.get("HTTP_ROOT_API_ENDPOINT");
    const BRIDGE_9C_ADDRESS: string = Configuration.get("BRIDGE_9C_ADDRESS");
    const BRIDGE_9C_PRIVATE_KEY: string = Configuration.get("BRIDGE_9C_PRIVATE_KEY");
    const CHAIN_ID: number = Configuration.get("CHAIN_ID", true, "integer");
    const KMS_PROVIDER_URL: string = Configuration.get("KMS_PROVIDER_URL");
    const KMS_PROVIDER_KEY_ID: string = Configuration.get("KMS_PROVIDER_KEY_ID");
    const KMS_PROVIDER_REGION: string = Configuration.get("KMS_PROVIDER_REGION");
    const KMS_PROVIDER_AWS_ACCESSKEY: string = Configuration.get("KMS_PROVIDER_AWS_ACCESSKEY");
    const KMS_PROVIDER_AWS_SECRETKEY: string = Configuration.get("KMS_PROVIDER_AWS_SECRETKEY");
    const WNCG_CONTRACT_ADDRESS: string = Configuration.get("WNCG_CONTRACT_ADDRESS");
    const MONITOR_STATE_STORE_PATH: string = Configuration.get("MONITOR_STATE_STORE_PATH");
    const SLACK_WEB_TOKEN: string = Configuration.get("SLACK_WEB_TOKEN");
    const EXPLORER_ROOT_URL: string = Configuration.get("EXPLORER_ROOT_URL");
    const ETHERSCAN_ROOT_URL: string = Configuration.get("ETHERSCAN_ROOT_URL");
    const DEBUG: boolean = Configuration.get("DEBUG", false, "boolean");
    const SENTRY_DSN: string | undefined = Configuration.get("SENTRY_DSN", false);
    if (SENTRY_DSN !== undefined) {
        init({
            dsn: SENTRY_DSN,
        });
    }

    const CONFIRMATIONS = 10;

    const monitorStateStore: IMonitorStateStore = await Sqlite3MonitorStateStore.open(MONITOR_STATE_STORE_PATH);
    const slackWebClient = new WebClient(SLACK_WEB_TOKEN);

    const headlessGraphQLCLient = new HeadlessGraphQLClient(GRAPHQL_API_ENDPOINT);
    const ncgTransfer: INCGTransfer = new NCGTransfer(headlessGraphQLCLient, BRIDGE_9C_ADDRESS);
    const kmsProvider = new KmsProvider(KMS_PROVIDER_URL, {
      region: KMS_PROVIDER_REGION,
      keyIds: [KMS_PROVIDER_KEY_ID],
      credential: {
        accessKeyId: KMS_PROVIDER_AWS_ACCESSKEY,
        secretAccessKey: KMS_PROVIDER_AWS_SECRETKEY
      }
    });
    const wNCGToken: ContractDescription = {
        abi: wNCGTokenAbi,
        address: WNCG_CONTRACT_ADDRESS,
    };
    const web3 = new Web3(kmsProvider);

    const ethereumBurnEventObserver = new EthereumBurnEventObserver(ncgTransfer, slackWebClient, monitorStateStore, EXPLORER_ROOT_URL, ETHERSCAN_ROOT_URL);
    const ethereumBurnEventMonitor = new EthereumBurnEventMonitor(web3, wNCGToken, await monitorStateStore.load("ethereum"), CONFIRMATIONS);
    ethereumBurnEventMonitor.attach(ethereumBurnEventObserver);

    const headlessHttpClient: IHeadlessHTTPClient = new HeadlessHTTPClient(HTTP_ROOT_API_ENDPOINT);
    await headlessHttpClient.setPrivateKey(BRIDGE_9C_PRIVATE_KEY);

    const kmsAddress = await kmsProvider.getAccounts();
    if(kmsAddress.length != 1) {
      throw Error("NineChronicles.EthBridge is supported only one address.");
    }
    console.log(kmsAddress)
    const minter: IWrappedNCGMinter = new WrappedNCGMinter(web3, wNCGToken, kmsAddress[0]);
    const ncgTransferredEventObserver = new NCGTransferredEventObserver(ncgTransfer, minter, slackWebClient, monitorStateStore, EXPLORER_ROOT_URL, ETHERSCAN_ROOT_URL);
    const nineChroniclesMonitor = new NineChroniclesTransferredEventMonitor(await monitorStateStore.load("nineChronicles"), 50, headlessGraphQLCLient, BRIDGE_9C_ADDRESS);
    // chain id, 1, means mainnet. See EIP-155, https://github.com/ethereum/EIPs/blob/master/EIPS/eip-155.md#specification.
    // It should be not able to run in mainnet because it is for test.
    if (DEBUG && CHAIN_ID !== 1) {
        nineChroniclesMonitor.attach(ncgTransferredEventObserver);
    }

    ethereumBurnEventMonitor.run();
    nineChroniclesMonitor.run();
})().catch(error => {
    console.error(error);
    process.exit(-1);
});