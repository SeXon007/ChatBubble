param([string]$Runtime = '', [string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!$Runtime) { $Runtime = Join-Path $root 'dist' }
if (!$OutputDirectory) { $OutputDirectory = Join-Path $root 'docs/verification/capture-exclusion-0.16.0/png' }
[void][IO.Directory]::CreateDirectory($OutputDirectory)
# Compile the actual production encoder, then exercise its private Encode method.
. (Join-Path $Runtime 'native/window-target.ps1') -CompileOnly | Out-Null
$compiler.ReferencedAssemblies.Add('System.Drawing.dll') | Out-Null
Add-Type -CompilerParameters $compiler -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Graphics.Imaging;
public static class OriginalPngCheck {
  public static byte[] Encode(byte[] pixels, int width, int height) {
    using(var bitmap=new SoftwareBitmap(BitmapPixelFormat.Bgra8,width,height,BitmapAlphaMode.Ignore)) {
      using(var writer=new Windows.Storage.Streams.DataWriter()) {
        writer.WriteBytes(pixels);bitmap.CopyFromBuffer(writer.DetachBuffer());
      }
      // An unstarted clock isolates encoding/size checks from the capture timeout.
      Type encoderType=null;
      foreach(var assembly in AppDomain.CurrentDomain.GetAssemblies()) {
        encoderType=assembly.GetType("ChatBubbleCapture.WindowFrame");if(encoderType!=null)break;
      }
      return (byte[])encoderType.GetMethod("Encode",BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,new object[]{bitmap,new Stopwatch()});
    }
  }
  public static byte[] Pixels(Bitmap bitmap) {
    var data=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
    try { byte[] pixels=new byte[bitmap.Width*bitmap.Height*4];Marshal.Copy(data.Scan0,pixels,0,pixels.Length);return pixels; }
    finally { bitmap.UnlockBits(data); }
  }
  public static byte[] TextPixels(int width,int height) {
    using(var bitmap=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
      using(var graphics=Graphics.FromImage(bitmap)) using(var font=new Font("Microsoft YaHei",14,GraphicsUnit.Pixel)) {
        graphics.Clear(Color.White);graphics.TextRenderingHint=TextRenderingHint.SingleBitPerPixelGridFit;
        for(int row=0;row<height/28;row++) graphics.DrawString("ChatBubble 原分辨率文字 0123456789 AaBbCc | SELECT * FROM messages WHERE id = 731;",font,Brushes.Black,20,row*28);
        for(int x=width-200;x<width-20;x+=2) graphics.DrawLine(Pens.Black,x,20,x,180);
      }
      return Pixels(bitmap);
    }
  }
}
'@
$width = 2560; $height = 1440
$pixels = [OriginalPngCheck]::TextPixels($width,$height)
$png = [OriginalPngCheck]::Encode($pixels,$width,$height)
[IO.File]::WriteAllBytes((Join-Path $OutputDirectory 'native-original.png'),$png)
$stream = [IO.MemoryStream]::new($png,$false)
$decoded = [Drawing.Bitmap]::new($stream)
try {
  $actualWidth=$decoded.Width; $actualHeight=$decoded.Height
  if($actualWidth -ne $width -or $actualHeight -ne $height){throw "Resolution changed: ${actualWidth}x${actualHeight}"}
  $actual=[OriginalPngCheck]::Pixels($decoded)
  $identical=$true
  for($i=0;$i -lt $pixels.Length;$i++){if($pixels[$i] -ne $actual[$i]){$identical=$false;break}}
  if(!$identical){throw 'PNG pixels changed; text/one-pixel lines must remain exact'}
} finally {$decoded.Dispose();$stream.Dispose()}
$noise=[byte[]]::new(3000*2000*4)
[Random]::new(731).NextBytes($noise)
for($i=3;$i -lt $noise.Length;$i+=4){$noise[$i]=255}
$oversizeError=''
try { [void][OriginalPngCheck]::Encode($noise,3000,2000) }
catch { $failure=$_.Exception;while($failure.InnerException){$failure=$failure.InnerException};$oversizeError=$failure.Message }
if($oversizeError -ne 'image-size'){throw "Expected unchanged 16 MB rejection; got: $oversizeError"}
$result=@{width=$width;height=$height;encodedBytes=$png.Length;exactPixels=$identical;oversizeRejected=$true;oversizeError=$oversizeError;nativeLimitBytes=16000000}
$result|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $OutputDirectory 'report.json') -Encoding utf8
$result|ConvertTo-Json
