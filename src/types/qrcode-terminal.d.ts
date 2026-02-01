declare module "qrcode-terminal" {
  interface GenerateOptions {
    small?: boolean;
  }

  const qrcode: {
    generate: (text: string, opts?: GenerateOptions) => void;
  };

  export default qrcode;
}
