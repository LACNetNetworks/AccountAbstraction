export const lnet = {
  id: Number(import.meta.env.VITE_LNET_CHAIN_ID || 648540),
  name: "LNET Testnet",
  bundlerUrl: import.meta.env.VITE_BUNDLER_URL || "https://bundler.l-net.io",
  rpcUrl: import.meta.env.VITE_READ_RPC_URL || import.meta.env.VITE_BUNDLER_URL || "https://bundler.l-net.io",
  lnetRpcUrl: import.meta.env.VITE_LNET_RPC_URL || "http://34.69.184.205:4545",
  entryPoint: import.meta.env.VITE_ENTRYPOINT_ADDRESS || "0x9fD181236dA8c890bD5007b44B80E395E130c57D",
  factory: import.meta.env.VITE_FACTORY_ADDRESS || "0x5589A0E344688976e473FD56BAe94411d9d56f67",
  storage: import.meta.env.VITE_STORAGE_ADDRESS || "0xDcEA70eDDFA7EAB3590A1Ac7c00B48D36b4a13c6",
};

export const lnetPrivyChain = {
  id: lnet.id,
  name: lnet.name,
  network: "lnet-testnet",
  nativeCurrency: {
    name: "LNET",
    symbol: "LNET",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [lnet.rpcUrl],
    },
  },
};
