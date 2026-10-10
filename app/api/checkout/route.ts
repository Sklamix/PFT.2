import { NextResponse } from 'next/server';
import crypto from 'crypto';

export async function POST(req: Request) {
  try {
    const { planSize, email } = await req.json();

    // 1. Визначаємо вартість залежно від розміру рахунку
    let amount = "79.00";
    if (planSize === 25000) amount = "169.00";
    if (planSize === 50000) amount = "289.00";
    if (planSize === 100000) amount = "489.00";
    if (planSize === 200000) amount = "899.00";
    if (planSize === 400000) amount = "1699.00";

    const orderId = `PFT-${Date.now()}`;
    const merchantId = process.env.CRYPTOMUS_MERCHANT_ID || '';
    const apiKey = process.env.CRYPTOMUS_API_KEY || '';

    // 2. Формуємо тіло запиту
    const payload = {
      amount: amount,
      currency: "USD",
      order_id: orderId,
      url_return: "https://nimbus-nine-orpin.vercel.app/dashboard",
      url_callback: "https://nimbus-nine-orpin.vercel.app/api/webhooks/payment-success",
      is_payment_multiple: false,
      lifetime: 3600, // Рахунок дійсний 1 годину
      additional_data: JSON.stringify({ email, planSize })
    };

    // 3. Генеруємо обов'язковий підпис Cryptomus: MD5(base64(JSON) + API_KEY)
    const jsonPayload = Buffer.from(JSON.stringify(payload)).toString('base64');
    const sign = crypto
      .createHash('md5')
      .update(jsonPayload + apiKey)
      .digest('hex');

    // 4. Відправляємо запит до платіжного шлюзу
    const response = await fetch('https://api.cryptomus.com/v1/payment', {
      method: 'POST',
      headers: {
        'merchant': merchantId,
        'sign': sign,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (data.state === 0 && data.result && data.result.url) {
      return NextResponse.json({ url: data.result.url });
    } else {
      console.error('Cryptomus error:', data);
      return NextResponse.json(
        { error: data.message || 'Помилка генерації рахунку' },
        { status: 400 }
      );
    }
  } catch (error) {
    console.error('Checkout route error:', error);
    return NextResponse.json(
      { error: 'Внутрішня помилка сервера' },
      { status: 500 }
    );
  }
}
